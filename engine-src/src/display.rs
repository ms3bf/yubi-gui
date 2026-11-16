use crate::deterministic::HashSet;
use crate::{
    api, candidate,
    catalog::{Action, Catalog},
    model::Model,
    normalization, path, scheduler, teacher_features,
};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
fn n(v: &Value) -> f64 {
    v.as_f64().unwrap()
}
pub fn multipliers(positions: &Value, config: &Value) -> Value {
    let mut raw = Map::new();
    for (i, v) in positions.as_object().unwrap() {
        if !v["rho"].is_null() {
            raw.insert(
                i.clone(),
                json!(-n(&config["alpha"]) * (n(&v["rho"]) / n(&config["rho0"])).tanh()),
            );
        }
    }
    let (lo, hi) = (n(&config["minimum"]).ln(), n(&config["maximum"]).ln());
    let (mut left, mut right) = (-2.0, 2.0);
    for _ in 0..70 {
        let center = (left + right) / 2.0;
        let sum = raw
            .values()
            .fold(0.0, |s, x| s + hi.min(lo.max(n(x) - center)));
        if sum > 0.0 {
            left = center;
        } else {
            right = center;
        }
    }
    let center = (left + right) / 2.0;
    let mut result = Map::new();
    for i in positions.as_object().unwrap().keys() {
        result.insert(
            i.clone(),
            json!(
                raw.get(i)
                    .map(|x| hi.min(lo.max(n(x) - center)).exp())
                    .unwrap_or(1.0)
            ),
        );
    }
    result.into()
}
fn structure(c: &Catalog, r: &Value) -> (usize, Vec<(usize, String)>) {
    let mut pos = 0;
    let mut rg = vec![];
    for key in r["path"].as_array().unwrap() {
        let a = c.get(key.as_str().unwrap()).unwrap();
        if a.mv == "REGRIP" {
            rg.push((pos, a.key.clone()));
        } else {
            pos += 1;
        }
    }
    (pos, rg)
}
fn group(a: &Action) -> String {
    let fingers = if a.driving.is_empty() {
        "()".into()
    } else {
        format!(
            "({}{})",
            a.driving
                .iter()
                .map(|f| format!("'{f}'"))
                .collect::<Vec<_>>()
                .join(", "),
            if a.driving.len() == 1 { "," } else { "" }
        )
    };
    format!("('{}', {}, '{}')", a.hand, fingers, a.d_class)
}
pub fn display(
    c: &Catalog,
    bundle: &Value,
    teacher: &Model,
    payload: &Value,
) -> Result<Value, String> {
    if !payload.is_object() || !payload["alg"].is_string() || !payload["path"].is_array() {
        return Err("alg/path required".into());
    }
    let alg = payload["alg"].as_str().unwrap();
    let tokens = path::parse(alg, 500)?;
    let keys: Vec<String> =
        serde_json::from_value(payload["path"].clone()).map_err(|_| "Display path size invalid")?;
    if keys.is_empty() || keys.len() > 250 || tokens.is_empty() || tokens.len() > 100 {
        return Err("Display path size invalid".into());
    }
    let initial = &payload["initial_holds"];
    if initial
        .as_object()
        .is_none_or(|v| v.len() != 2 || !v.contains_key("L") || !v.contains_key("R"))
    {
        return Err("Initial holds required".into());
    }
    let p = &bundle["params"];
    candidate::verify(c, alg, &keys)?;
    let _base = scheduler::schedule(c, p, payload)?;
    let raw = json!({"path":keys,"initial_holds":initial});
    let canonical = normalization::normalize(c, p, &raw)?;
    let shape = structure(c, &canonical);
    let canon_plan = scheduler::schedule(c, p, &canonical)?;
    let mut features = vec![teacher_features::extract(
        c,
        p,
        &canonical,
        &canon_plan,
        None,
    )?];
    let mut costs = vec![n(&canon_plan["cost"]) as f32];
    let mut positions = Map::new();
    let mut alternatives = vec![];
    let mut holds = initial.clone();
    let mut move_index = 0;
    for (index, key) in keys.iter().enumerate() {
        let a = c.get(key)?;
        let after = a.next_holds(&holds)?;
        if a.mv == "REGRIP" {
            holds = after;
            continue;
        }
        let options: Vec<_> = c
            .actions
            .iter()
            .filter(|b| {
                b.mv == a.mv
                    && b.key != *key
                    && b.matches(&tokens[move_index])
                    && b.next_holds(&holds).is_ok_and(|h| h == after)
            })
            .collect();
        let mut sorted = options.clone();
        sorted.sort_by(|a, b| a.key.cmp(&b.key));
        let mut groups = BTreeMap::new();
        for b in sorted {
            groups.entry(group(b)).or_insert(b);
        }
        let mut ordered: Vec<_> = groups.values().copied().collect();
        let selected_keys: HashSet<_> = ordered.iter().map(|a| a.key.clone()).collect();
        ordered.extend(
            options
                .into_iter()
                .filter(|b| !selected_keys.contains(&b.key)),
        );
        let mut selected = vec![];
        for b in ordered.into_iter().take(8) {
            if selected.len() == 4 {
                break;
            }
            let mut trial = raw.clone();
            trial["path"][index] = json!(b.key);
            let attempt = (|| -> Result<Option<(Vec<f32>, f32)>, String> {
                candidate::verify(
                    c,
                    alg,
                    &serde_json::from_value::<Vec<String>>(trial["path"].clone()).unwrap(),
                )?;
                let r = normalization::normalize(c, p, &trial)?;
                if structure(c, &r) != shape {
                    return Ok(None);
                }
                let plan = scheduler::schedule(c, p, &r)?;
                let f = teacher_features::extract(c, p, &r, &plan, None)?;
                Ok(Some((f, n(&plan["cost"]) as f32)))
            })();
            if let Ok(Some((f, cost))) = attempt {
                selected.push(features.len());
                features.push(f);
                costs.push(cost);
                alternatives.push(
                    json!({"path_index":index,"action":b.key,"score_index":features.len()-1}),
                );
            }
        }
        positions.insert(index.to_string(),json!({"key":key,"move_index":move_index,"base_duration":p["d"][&a.d_class],"indices":selected}));
        holds = after;
        move_index += 1;
    }
    let scores = teacher.teacher(
        &features,
        &costs,
        tokens.len(),
        &bundle["teacher"]["transform"],
    );
    for v in positions.values_mut() {
        let diffs: Vec<f64> = v["indices"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| (scores[i.as_u64().unwrap() as usize] - scores[0]) as f64)
            .collect();
        v.as_object_mut().unwrap().remove("indices");
        let mut sorted = diffs.clone();
        sorted.sort_by(f64::total_cmp);
        let median = if sorted.is_empty() {
            0.0
        } else if sorted.len() % 2 == 0 {
            (sorted[sorted.len() / 2 - 1] + sorted[sorted.len() / 2]) / 2.0
        } else {
            sorted[sorted.len() / 2]
        };
        v["comparisons"] = json!(diffs.len());
        v["rho"] = if !diffs.is_empty() && n(&v["base_duration"]) > 0.0 {
            json!(tokens.len() as f64 * median / n(&v["base_duration"]))
        } else {
            Value::Null
        };
        v["deltas"] = json!(diffs);
    }
    for v in &mut alternatives {
        let i = v["score_index"].as_u64().unwrap() as usize;
        v.as_object_mut().unwrap().remove("score_index");
        v["delta"] = json!((scores[i] - scores[0]) as f64);
    }
    let positions = Value::Object(positions);
    let ms = multipliers(&positions, &bundle["display_config"]);
    let mut plan = scheduler::schedule(
        c,
        p,
        &json!({"path":keys,"initial_holds":initial,"duration_multipliers":ms}),
    )?;
    plan["alg"] = json!(alg);
    plan = api::adapt(&plan, c, &bundle["model_version"]);
    plan.as_object_mut().unwrap().remove("end_state");
    plan["display_only"] = json!(true);
    plan["time_basis"] = json!("teacher_preference_relative_display");
    let mut adjustments = Map::new();
    for (i, v) in positions.as_object().unwrap() {
        let mut out = json!({"multiplier":ms[i]});
        for (k, x) in v.as_object().unwrap() {
            out[k] = x.clone();
        }
        out["reason"] = json!(if v["comparisons"].as_u64().unwrap() > 0 {
            "合法な代替手との教師評価差（前後への影響を含む）。相対表示用。"
        } else {
            "同じホールド遷移を保つ比較候補がなく、倍率1。"
        });
        adjustments.insert(i.clone(), out);
    }
    Ok(
        json!({"display":plan,"adjustments":adjustments,"adjusted_count":ms.as_object().unwrap().values().filter(|v|(n(v)-1.0).abs()>1e-6).count(),"teacher_score":scores[0] as f64,"teacher_candidates":features.len(),"timing":{"comparison":0.0,"teacher_inference":0.0,"total":0.0},"cache_hit":false,"normalization":"geometric_mean_1; clip duration excluded; recovery/regrip priors unchanged"}),
    )
}
