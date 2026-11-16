use crate::deterministic::HashSet;
use crate::{
    candidate,
    catalog::{Catalog, HOLDS},
    features::Features,
    model::Model,
    normalization, path, scheduler, teacher_features,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
pub const MODEL_LABEL: &str = "fast_teacher_S0_972_beam64";
pub fn pyjson(v: &Value, sort: bool, ascii: bool) -> String {
    match v {
        Value::Array(arr) => format!(
            "[{}]",
            arr.iter()
                .map(|v| pyjson(v, sort, ascii))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Value::Object(obj) => {
            let mut keys: Vec<_> = obj.keys().collect();
            if sort {
                keys.sort();
            }
            format!(
                "{{{}}}",
                keys.iter()
                    .map(|k| format!(
                        "{}: {}",
                        pyjson(&json!(k), false, ascii),
                        pyjson(&obj[*k], sort, ascii)
                    ))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }
        Value::String(txt) => {
            let raw = serde_json::to_string(txt).unwrap();
            if ascii {
                raw.chars()
                    .map(|c| {
                        if c.is_ascii() {
                            c.to_string()
                        } else {
                            c.encode_utf16(&mut [0; 2])
                                .iter()
                                .map(|u| format!("\\u{u:04x}"))
                                .collect()
                        }
                    })
                    .collect()
            } else {
                raw
            }
        }
        _ => v.to_string(),
    }
}
pub fn adapt(source: &Value, c: &Catalog, version: &Value) -> Value {
    let mut r = source.clone();
    let input = json!([r["path"], r["initial_holds"], version]);
    let digest = Sha256::digest(pyjson(&input, true, true).as_bytes());
    let id = format!("{digest:x}")[..20].to_owned();
    for(k,v)in json!({"id":id,"model_version":version,"provenance":"model-search","model_name":MODEL_LABEL,"d_u_flick":1.0,"playback_start":r["origin"]}).as_object().unwrap(){r[k]=v.clone();}
    let mut positions = BTreeMap::new();
    let mut key_positions: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for m in r["moves"].as_array_mut().unwrap() {
        positions.insert(m["id"].as_str().unwrap().to_owned(), m["i"].clone());
        key_positions
            .entry(m["key"].as_str().unwrap().to_owned())
            .or_default()
            .push(m.clone());
        let a = c.get(m["key"].as_str().unwrap()).unwrap();
        m["start_pose"] = json!(pyjson(&json!(a.start), false, false));
        m["end_pose"] = json!(pyjson(&json!(a.end), false, false));
    }
    let moves = r["moves"].as_array().unwrap().clone();
    for rg in r["regrips"].as_array_mut().unwrap() {
        rg["hold_from"] = rg["hold_before"].clone();
        rg["hold_to"] = rg["hold_after"].clone();
        let after = moves
            .iter()
            .filter(|m| m["path_index"].as_i64().unwrap() < rg["path_index"].as_i64().unwrap())
            .count() as i64
            - 1;
        rg["after_pos"] = json!(after);
        positions.insert(rg["id"].as_str().unwrap().into(), json!(after.max(0)));
    }
    for events in r["lanes"].as_object_mut().unwrap().values_mut() {
        for e in events.as_array_mut().unwrap() {
            if let Some(i) = e["event_id"].as_str().and_then(|id| positions.get(id)) {
                e["i"] = i.clone();
            } else if let Some(ms) = e["target_action"]
                .as_str()
                .and_then(|key| key_positions.get(key))
            {
                if let Some(m) = ms
                    .iter()
                    .find(|m| m["start"].as_f64().unwrap() >= e["end"].as_f64().unwrap() - 1e-8)
                {
                    e["i"] = m["i"].clone();
                }
            }
        }
    }
    r
}
pub fn resolve_path(c: &Catalog, path: &Value, initial: &Value) -> Result<Vec<String>, String> {
    let mut holds = initial.clone();
    let mut result = vec![];
    for value in path.as_array().ok_or("Invalid path")? {
        let choices: Vec<_> = if value.is_object() {
            c.actions
                .iter()
                .filter(|a| {
                    value["hand"] == a.hand
                        && value["action_id"] == a.action_id
                        && value["hold_before"] == a.before
                })
                .collect()
        } else if let Some(text) = value.as_str() {
            if text.starts_with("RG:") {
                let parts: Vec<_> = text.split(':').collect();
                if parts.len() != 3 {
                    return Err(format!("Invalid regrip token: {text}"));
                }
                let tr: Vec<_> = parts[2].split('>').collect();
                if tr.len() != 2 {
                    return Err(format!("Invalid regrip token: {text}"));
                }
                vec![
                    c.regrip(parts[1], tr[0], tr[1])
                        .ok_or_else(|| format!("Invalid regrip token: {text}"))?,
                ]
            } else if let Ok(a) = c.get(text) {
                vec![a]
            } else {
                c.actions
                    .iter()
                    .filter(|a| {
                        a.action_id == text && (a.operation.is_some() || holds[&a.hand] == a.before)
                    })
                    .collect()
            }
        } else {
            return Err("Invalid path reference".into());
        };
        let valid: Vec<_> = choices
            .into_iter()
            .filter(|a| a.next_holds(&holds).is_ok())
            .collect();
        if valid.len() != 1 {
            return Err(format!(
                "Path reference is missing or ambiguous: {}",
                value
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| pyjson(value, false, false))
            ));
        }
        holds = valid[0].next_holds(&holds)?;
        result.push(valid[0].key.clone());
    }
    Ok(result)
}
pub fn refresh(c: &Catalog, bundle: &Value, r: &Value) -> Result<Value, String> {
    let alg = r["alg"].as_str().ok_or("alg が必要です")?;
    if r["path"]
        .as_array()
        .is_none_or(|v| v.is_empty() || v.len() > 500)
    {
        return Err("保存経路が必要です".into());
    }
    let incoming = r.get("initial_state").filter(|v| !v.is_null());
    if let Some(state) = incoming {
        crate::continuation::validate(c, &bundle["params"], state)?;
        if r["initial_holds"] != state["projected_hold"] {
            return Err("Initial holds disagree with continuation state".into());
        }
        if r.get("origin").is_some_and(|v| v.as_f64() != state["t"].as_f64()) {
            return Err("Replay origin must match continuation state time".into());
        }
        if r.get("model_version").is_some_and(|v| v != &bundle["model_version"]) {
            return Err("Replay model version does not match the current engine".into());
        }
        if r.get("schema_version").is_some_and(|v| v != 2)
            || state.get("schema_version").is_some_and(|v| v != 2)
        {
            return Err("Unsupported continuation replay schema".into());
        }
    } else if r.get("origin")
        .is_some_and(|v| v.as_f64().unwrap_or(0.0) != 0.0)
    {
        return Err("連結状態を持つ記録は、最新の状態から再探索してください".into());
    }
    let keys = resolve_path(c, &r["path"], &r["initial_holds"])?;
    candidate::verify(c, alg, &keys)?;
    let mut result = scheduler::schedule(
        c,
        &bundle["params"],
        &json!({"path":keys,"initial_holds":r["initial_holds"],"initial_state":incoming}),
    )?;
    result["alg"] = json!(alg);
    result["model_version"] = bundle["model_version"].clone();
    Ok(result)
}
pub fn search(
    c: &Catalog,
    bundle: &Value,
    student: &Model,
    teacher: &Model,
    payload: &Value,
) -> Result<Value, String> {
    let alg = payload["alg"].as_str().ok_or("手順を入力してください")?;
    let tokens = path::parse(alg, 500)?;
    if tokens.is_empty() || tokens.len() > 100 {
        return Err("手順は展開後1〜100手で入力してください".into());
    }
    let empty = json!([]);
    let pins = payload.get("constraints").unwrap_or(&empty);
    let excluded = payload.get("exclude").unwrap_or(&empty);
    if !pins.is_array() || !excluded.is_array() {
        return Err("固定・除外は配列が必要です".into());
    }
    for item in excluded.as_array().unwrap() {
        if !item.is_object()
            || item["pos"]
                .as_u64()
                .is_none_or(|i| i >= tokens.len() as u64)
            || !item["action_id"].is_string()
        {
            return Err("除外条件が不正です".into());
        }
    }
    let hold = payload.get("start_hold").unwrap_or(&Value::Null);
    let hold = if payload.get("start_hold").is_none() {
        "auto"
    } else {
        hold.as_str().ok_or("開始ホールドが不正です")?
    };
    if hold != "auto" && !HOLDS.contains(&hold) {
        return Err("開始ホールドが不正です".into());
    }
    let default = json!({"R":hold,"L":hold});
    let requested = payload.get("start_holds").unwrap_or(&default);
    if requested.as_object().is_none_or(|v| v.len() != 2)
        || !["R", "L"].iter().all(|h| {
            requested[*h]
                .as_str()
                .is_some_and(|v| v == "auto" || HOLDS.contains(&v))
        })
    {
        return Err("左右の開始ホールドが不正です".into());
    }
    if payload.get("start_holds").is_some() && payload.get("start_hold").is_some() {
        return Err("start_holdとstart_holdsを同時に指定できません".into());
    }
    let incoming = payload.get("initial_state").filter(|v| !v.is_null());
    if let Some(state) = incoming { crate::continuation::validate(c, &bundle["params"], state)?; }
    let prefix = payload.get("prefix").filter(|v| !v.is_null());
    let mut fixed = None;
    if let Some(v) = prefix {
        if v.as_object().is_none_or(|v| {
            v.len() != 2 || !v.contains_key("path") || !v.contains_key("initial_holds")
        }) {
            return Err("prefix requires path and initial_holds".into());
        }
        fixed = Some(&v["initial_holds"]);
    } else if let Some(v) = incoming {
        fixed = Some(v.get("projected_hold").unwrap_or(&v["hold"]));
    }
    let starts: Vec<Value> = if prefix.is_some() || incoming.is_some() {
        let fixed = fixed.unwrap();
        if fixed.as_object().is_none_or(|v| v.len() != 2)
            || !["R", "L"]
                .iter()
                .all(|h| fixed[*h].as_str().is_some_and(|v| HOLDS.contains(&v)))
        {
            return Err("Invalid fixed initial holds".into());
        }
        if ["R", "L"]
            .iter()
            .any(|h| requested[*h] != "auto" && requested[*h] != fixed[*h])
        {
            return Err("指定した開始ホールドが固定経路・引継ぎ状態と一致しません".into());
        }
        vec![fixed.clone()]
    } else if requested["R"] == "auto" && requested["L"] == "auto" {
        vec![Value::Null]
    } else {
        let rs = if requested["R"] == "auto" {
            HOLDS.to_vec()
        } else {
            vec![requested["R"].as_str().unwrap()]
        };
        let ls = if requested["L"] == "auto" {
            HOLDS.to_vec()
        } else {
            vec![requested["L"].as_str().unwrap()]
        };
        rs.iter()
            .flat_map(|r| ls.iter().map(move |l| json!({"R":r,"L":l})))
            .collect()
    };
    let p = &bundle["params"];
    let f = Features::new(c, &bundle["student"]);
    let mut candidates = vec![];
    let mut first_reason = String::new();
    let mut first_errors = vec![];
    for (start_index, start) in starts.into_iter().enumerate() {
        let req = json!({"alg":alg,"pins":pins,"initial_holds":start,"initial_state":incoming,"prefix_path":prefix.map(|v|&v["path"])});
        let raw = candidate::solve(c, p, &f, student, &req)?;
        let editable = !pins.as_array().unwrap().is_empty()
            || prefix.is_some()
            || !start.is_null()
            || incoming.is_some_and(|v| !v.as_object().unwrap().is_empty());
        let mut seen = HashSet::default();
        let mut plans = vec![];
        let mut features = vec![];
        let mut costs = vec![];
        let mut errors = vec![];
        for route in raw["candidates"].as_array().unwrap() {
            let attempt = (|| -> Result<Option<(Value, Vec<f32>, f32)>, String> {
                let normalized = if editable {
                    route.clone()
                } else {
                    normalization::normalize(c, p, route)?
                };
                let key = normalization::identity(&normalized);
                if seen.contains(&key) {
                    return Ok(None);
                }
                let normalized_keys: Vec<String> =
                    serde_json::from_value(normalized["path"].clone()).unwrap();
                let use_normalized = candidate::verify(c, alg, &normalized_keys).is_ok();
                let shown = if use_normalized { &normalized } else { route };
                if !use_normalized {
                    candidate::verify(
                        c,
                        alg,
                        &serde_json::from_value::<Vec<String>>(route["path"].clone()).unwrap(),
                    )?;
                }
                let schedule = |r: &Value| {
                    scheduler::schedule(
                        c,
                        p,
                        &json!({"path":r["path"],"initial_holds":r["initial_holds"],"initial_state":incoming}),
                    )
                };
                let mut plan = schedule(shown)?;
                plan["alg"] = json!(alg);
                let scored = if use_normalized {
                    plan.clone()
                } else {
                    schedule(&normalized)?
                };
                let x = teacher_features::extract(c, p, &normalized, &scored, incoming)?;
                seen.insert(key);
                Ok(Some((plan, x, scored["cost"].as_f64().unwrap() as f32)))
            })();
            match attempt {
                Ok(Some((plan, x, cost))) => {
                    plans.push(plan);
                    features.push(x);
                    costs.push(cost);
                }
                Ok(None) => {}
                Err(e) => errors.push(e),
            }
        }
        let scores = teacher.teacher(
            &features,
            &costs,
            tokens.len(),
            &bundle["teacher"]["transform"],
        );
        let mut ranked = vec![];
        for (mut plan, score) in plans.into_iter().zip(scores) {
            plan["preference_score"] = json!(score as f64);
            plan["physical_cost"] = plan["cost"].clone();
            plan["score_units"] = json!("relative preference energy");
            let tie = normalization::tie_key(c, p, &plan)?;
            ranked.push((score, tie, plan));
        }
        ranked.sort_by(|a, b| {
            round10(a.0 as f64)
                .total_cmp(&round10(b.0 as f64))
                .then(a.1.cmp(&b.1))
        });
        let k = if excluded.as_array().unwrap().is_empty() {
            8
        } else {
            32
        };
        for (score, tie, plan) in ranked.into_iter().take(k) {
            if excluded.as_array().unwrap().iter().all(|e| {
                let m = &plan["moves"][e["pos"].as_u64().unwrap() as usize];
                m["action_id"] != e["action_id"] && m["key"] != e["action_id"]
            }) {
                candidates.push((score, tie, plan));
            }
        }
        if start_index == 0 {
            first_reason = raw["reason"].as_str().unwrap_or("").into();
            first_errors = errors;
        }
    }
    candidates.sort_by(|a, b| {
        round10(a.0 as f64)
            .total_cmp(&round10(b.0 as f64))
            .then(a.1.cmp(&b.1))
    });
    let routes: Vec<_> = candidates
        .into_iter()
        .take(8)
        .map(|(_, _, plan)| {
            let mut r = adapt(&plan, c, &bundle["model_version"]);
            for (e, t) in r["moves"].as_array_mut().unwrap().iter_mut().zip(&tokens) {
                e["input_move"] = json!(t.mv);
            }
            r
        })
        .collect();
    let reason = if routes.is_empty() {
        format!(
            "固定・除外条件を満たす候補が探索範囲内にありません。{}",
            if !first_reason.is_empty() {
                first_reason
            } else if !first_errors.is_empty() {
                format!(
                    "[{}]",
                    first_errors
                        .iter()
                        .map(|s| format!("'{s}'"))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            } else {
                "".into()
            }
        )
    } else {
        "".into()
    };
    Ok(
        json!({"alg":tokens.iter().map(|t|t.mv.clone()).collect::<Vec<_>>().join(" "),"routes":routes,"model":MODEL_LABEL,"model_version":bundle["model_version"],"search_method":MODEL_LABEL,"reason":reason,"exclusion_policy":if excluded.as_array().unwrap().is_empty(){Value::Null}else{json!("最大32候補から除外条件を適用")}}),
    )
}
pub fn round10(v: f64) -> f64 {
    format!("{v:.10}").parse().unwrap()
}
