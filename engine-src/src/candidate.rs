use crate::deterministic::HashMap;
use crate::{
    catalog::{Action, Catalog, HOLDS},
    features::{Features, State},
    model::Model,
    path, scheduler,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
#[derive(Clone)]
struct Candidate {
    path: Vec<String>,
    holds: (String, String),
    initial: (String, String),
    heuristic: f64,
}
fn holds(h: &(String, String)) -> Value {
    json!({"L":h.0,"R":h.1})
}
fn pair(h: &Value) -> (String, String) {
    (
        h["L"].as_str().unwrap().into(),
        h["R"].as_str().unwrap().into(),
    )
}
fn signature(c: &Catalog, v: &Candidate) -> Vec<(String, Vec<String>)> {
    v.path
        .iter()
        .map(|k| c.get(k).unwrap())
        .filter(|a| a.mv != "REGRIP")
        .map(|a| {
            (
                a.hand.clone(),
                if a.driving.is_empty() {
                    vec!["wrist".into()]
                } else {
                    a.driving.clone()
                },
            )
        })
        .collect()
}
fn prune(c: &Catalog, mut children: Vec<Candidate>, beam: usize) -> Vec<Candidate> {
    children.sort_by(|a, b| {
        a.heuristic
            .total_cmp(&b.heuristic)
            .then(a.path.cmp(&b.path))
            .then(a.initial.cmp(&b.initial))
    });
    let mut selected = children[..children.len().min((beam / 2).max(1))].to_vec();
    let mut used: BTreeSet<_> = selected
        .iter()
        .map(|v| (v.path.clone(), v.initial.clone()))
        .collect();
    let mut fingerprints: BTreeSet<_> = selected.iter().map(|v| signature(c, v)).collect();
    for v in &children {
        if selected.len() == beam {
            break;
        }
        let sig = signature(c, v);
        if !fingerprints.contains(&sig) {
            selected.push(v.clone());
            used.insert((v.path.clone(), v.initial.clone()));
            fingerprints.insert(sig);
        }
    }
    for v in children {
        if selected.len() == beam {
            break;
        }
        if used.insert((v.path.clone(), v.initial.clone())) {
            selected.push(v);
        }
    }
    selected
}
pub fn verify(c: &Catalog, alg: &str, keys: &[String]) -> Result<(), String> {
    let expected = path::parse(alg, 500)?;
    let turns: Vec<_> = keys
        .iter()
        .map(|k| c.get(k))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|a| a.mv != "REGRIP")
        .collect();
    if turns.len() != expected.len() {
        return Err("Path does not have one action per input move".into());
    }
    let mut physical = vec![];
    for (i, (a, t)) in turns.iter().zip(&expected).enumerate() {
        if !a.matches(t) {
            return Err(format!("Path token mismatch at {i}: {} vs {}", a.mv, t.mv));
        }
        if a.components.is_empty() {
            physical.push(a.mv.clone());
        } else {
            physical.extend(
                a.components
                    .iter()
                    .map(|s| s["move"].as_str().unwrap().to_owned()),
            );
        }
    }
    if path::state(&physical)
        != path::state(&expected.into_iter().map(|t| t.mv).collect::<Vec<_>>())
    {
        return Err("Physical component path has a different cube permutation".into());
    }
    Ok(())
}
type CacheKey = (Vec<String>, (String, String));
fn record(
    f: &Features,
    model: &Model,
    ctx: &[Vec<f32>],
    n: usize,
    keys: &[String],
    initial: &(String, String),
    cache: &mut HashMap<CacheKey, (State, f64)>,
) -> Result<(State, f64), String> {
    let key = (keys.to_vec(), initial.clone());
    if let Some(v) = cache.get(&key) {
        return Ok(v.clone());
    }
    let (state, total) = if keys.is_empty() {
        let h = holds(initial);
        (f.initial(h.clone()), f.root_event(&h).score(model, ctx))
    } else {
        let (parent, sum) = record(f, model, ctx, n, &keys[..keys.len() - 1], initial, cache)?;
        let (state, event) = f.step(&parent, f.ids[keys.last().unwrap()], n)?;
        (state, sum + event.score(model, ctx))
    };
    cache.insert(key, (state.clone(), total));
    Ok((state, total))
}
fn valid_regrip_target(value: &Value) -> bool {
    value.as_object().is_some_and(|v| v.len() == 2)
        && value["hand"].as_str().is_some_and(|v| ["L", "R"].contains(&v))
        && value["to_hold"].as_str().is_some_and(|v| HOLDS.contains(&v))
}
fn matches_regrip(need: &Value, action: Option<&Action>) -> bool {
    if let Some(required) = need.as_bool() {
        required == action.is_some()
    } else {
        action.is_some_and(|rg| need["hand"] == rg.hand && need["to_hold"] == rg.after)
    }
}
pub fn solve(
    c: &Catalog,
    p: &Value,
    f: &Features,
    model: &Model,
    request: &Value,
) -> Result<Value, String> {
    let alg = request["alg"].as_str().ok_or("alg required")?;
    let tokens = path::parse(alg, 500)?;
    let beam = request["beam"].as_u64().unwrap_or(64) as usize;
    if beam == 0 {
        return Err("beam and k must be positive".into());
    }
    let incoming = request
        .get("initial_state")
        .filter(|v| !v.is_null());
    let mut initial = request
        .get("initial_holds")
        .filter(|v| v.is_object() && !v.as_object().unwrap().is_empty())
        .cloned();
    if let Some(inc) = incoming {
        crate::continuation::validate(c, p, inc)?;
        let h = inc.get("projected_hold").unwrap_or(&inc["hold"]);
        if initial.as_ref().is_some_and(|v| v != h) {
            return Err("Initial holds disagree with incoming state".into());
        }
        initial = Some(h.clone());
    }
    let mut constraints: BTreeMap<usize, Value> = BTreeMap::new();
    if let Some(pins) = request.get("pins") {
        for pin in pins.as_array().ok_or("Invalid pins")? {
            let pos = pin["pos"]
                .as_u64()
                .ok_or("Pin position outside algorithm")? as usize;
            if pos >= tokens.len() {
                return Err("Pin position outside algorithm".into());
            }
            if pin.as_object().ok_or("Invalid pin")?.keys().any(|k| {
                ![
                    "pos",
                    "action_id",
                    "regrip_after",
                    "regrip_before",
                    "no_regrip_before",
                ]
                .contains(&k.as_str())
            }) {
                return Err("Unknown pin field".into());
            }
            if let Some(rg) = pin.get("regrip_before") {
                if !valid_regrip_target(rg)
                {
                    return Err("Invalid regrip_before: hand and to_hold required".into());
                }
            }
            for key in ["no_regrip_before"] {
                if pin.get(key).is_some_and(|v| !v.is_boolean()) {
                    return Err(format!("{key} must be boolean"));
                }
            }
            if pin.get("regrip_after").is_some_and(|v| !v.is_boolean() && !valid_regrip_target(v)) {
                return Err("regrip_after must be boolean or {hand, to_hold}".into());
            }
            let old = constraints.entry(pos).or_insert(json!({}));
            for (k, v) in pin.as_object().unwrap() {
                if old.get(k).is_some_and(|x| x != v) {
                    return Err("Conflicting pins at one position".into());
                }
                old[k] = v.clone();
            }
        }
    }
    if initial.as_ref().is_some_and(|h| {
        h.as_object().is_none_or(|v| v.len() != 2)
            || !["L", "R"]
                .iter()
                .all(|k| h[*k].as_str().is_some_and(|v| HOLDS.contains(&v)))
    }) {
        return Err("Invalid initial holds".into());
    }
    let starts: Vec<_> = if let Some(h) = &initial {
        vec![pair(h)]
    } else {
        HOLDS
            .into_iter()
            .flat_map(|l| HOLDS.map(|r| (l.into(), r.into())))
            .collect()
    };
    let mut frontier: Vec<_> = starts
        .iter()
        .map(|h| Candidate {
            path: vec![],
            holds: h.clone(),
            initial: h.clone(),
            heuristic: 0.0,
        })
        .collect();
    let mut prefix_count = 0;
    if let Some(prefix) = request.get("prefix_path").filter(|v| !v.is_null()) {
        let prefix: Vec<String> =
            serde_json::from_value(prefix.clone()).map_err(|_| "Invalid prefix path")?;
        if prefix.iter().any(|k| c.get(k).is_err()) {
            return Err("Invalid prefix path".into());
        }
        let Some(h) = &initial else {
            return Err("A fixed prefix requires initial holds".into());
        };
        if prefix
            .last()
            .is_some_and(|k| c.get(k).unwrap().mv == "REGRIP")
        {
            return Err("Prefix must end with a move".into());
        }
        prefix_count = prefix
            .iter()
            .filter(|k| c.get(k).unwrap().mv != "REGRIP")
            .count();
        if prefix_count >= tokens.len() {
            return Err("Prefix must leave at least one move to search".into());
        }
        verify(
            c,
            &tokens[..prefix_count]
                .iter()
                .map(|t| t.mv.clone())
                .collect::<Vec<_>>()
                .join(" "),
            &prefix,
        )?;
        let mut h = h.clone();
        let mut pos = 0;
        let mut preceding = None;
        for key in &prefix {
            let a = c.get(key)?;
            h = a.next_holds(&h)?;
            if a.mv == "REGRIP" {
                if preceding.is_some() {
                    return Err("Consecutive prefix regrips".into());
                }
                preceding = Some(a);
                continue;
            }
            let pin = constraints.get(&pos).cloned().unwrap_or(json!({}));
            if pin
                .get("action_id")
                .is_some_and(|v| *v != a.key && *v != a.action_id)
            {
                return Err("Fixed prefix conflicts with action pin".into());
            }
            if pin["no_regrip_before"] == true && preceding.is_some() {
                return Err("Fixed prefix conflicts with no_regrip_before".into());
            }
            if let Some(need) = pin.get("regrip_before") {
                if preceding.is_none_or(|rg| need["hand"] != rg.hand || need["to_hold"] != rg.after)
                {
                    return Err("Fixed prefix conflicts with regrip pin".into());
                }
            }
            if let Some(need) = pos
                .checked_sub(1)
                .and_then(|i| constraints.get(&i))
                .and_then(|v| v.get("regrip_after"))
            {
                if !matches_regrip(need, preceding) {
                    return Err("Fixed prefix conflicts with regrip_after".into());
                }
            }
            preceding = None;
            pos += 1;
        }
        frontier = vec![Candidate {
            path: prefix,
            holds: pair(&h),
            initial: starts[0].clone(),
            heuristic: 0.0,
        }];
    }
    let move_ids = tokens
        .iter()
        .map(|t| {
            f.mids
                .get(&t.mv)
                .copied()
                .ok_or_else(|| format!("Unsupported model move: {}", t.mv))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let ctx = model.contexts(&move_ids);
    let mut cache = HashMap::default();
    let mut expanded = 0;
    for (i, token) in tokens.iter().enumerate().skip(prefix_count) {
        let pin = constraints.get(&i).cloned().unwrap_or(json!({}));
        let options: Vec<_> = c
            .actions
            .iter()
            .filter(|a| {
                a.matches(token)
                    && pin
                        .get("action_id")
                        .is_none_or(|v| *v == a.key || *v == a.action_id)
            })
            .collect();
        let mut legal = BTreeMap::new();
        for l in HOLDS {
            for r in HOLDS {
                let h = json!({"L":l,"R":r});
                legal.insert(
                    (l.to_string(), r.to_string()),
                    options
                        .iter()
                        .filter_map(|a| a.next_holds(&h).ok().map(|next| (*a, pair(&next))))
                        .collect::<Vec<_>>(),
                );
            }
        }
        let mut children = vec![];
        for old in &frontier {
            let mut variants = vec![(None, old.holds.clone(), old.heuristic)];
            if !(old.path.is_empty() && incoming.is_some_and(|v| v["last_was_regrip"] == true)) {
                for h in ["L", "R"] {
                    for to in HOLDS {
                        let from = if h == "L" { &old.holds.0 } else { &old.holds.1 };
                        if let Some(rg) = c.regrip(h, from, to) {
                            let mut next = old.holds.clone();
                            if h == "L" {
                                next.0 = to.into();
                            } else {
                                next.1 = to.into();
                            }
                            let delta = (HOLDS.iter().position(|v| *v == rg.before).unwrap()
                                as i32
                                - HOLDS.iter().position(|v| *v == rg.after).unwrap() as i32)
                                .abs();
                            variants.push((
                                Some(rg),
                                next,
                                old.heuristic
                                    + p["g"][if delta == 1 { "adjacent" } else { "far" }]
                                        .as_f64()
                                        .unwrap(),
                            ));
                        }
                    }
                }
            }
            for (rg, h, _) in variants {
                if pin["no_regrip_before"] == true && rg.is_some() {
                    continue;
                }
                if let Some(need) = pin.get("regrip_before") {
                    if rg.is_none_or(|rg| need["hand"] != rg.hand || need["to_hold"] != rg.after) {
                        continue;
                    }
                }
                if let Some(need) = i
                    .checked_sub(1)
                    .and_then(|i| constraints.get(&i))
                    .and_then(|v| v.get("regrip_after"))
                {
                    if !matches_regrip(need, rg) {
                        continue;
                    }
                }
                for (a, next) in &legal[&h] {
                    let mut keys = old.path.clone();
                    if let Some(rg) = rg {
                        keys.push(rg.key.clone());
                    }
                    keys.push(a.key.clone());
                    if a.required_wrist_pose.is_some()
                        && scheduler::validate_entry(c, &keys, &holds(&old.initial), incoming)
                            .is_err()
                    {
                        continue;
                    }
                    let (_, score) = record(
                        f,
                        model,
                        &ctx,
                        tokens.len(),
                        &keys,
                        &old.initial,
                        &mut cache,
                    )?;
                    children.push(Candidate {
                        path: keys,
                        holds: next.clone(),
                        initial: old.initial.clone(),
                        heuristic: score,
                    });
                    expanded += 1;
                }
            }
        }
        if children.is_empty() {
            return Ok(
                json!({"alg":alg,"candidates":[],"reason":format!("No legal candidates at position {i}"),"expanded":expanded}),
            );
        }
        frontier = prune(c, children, beam);
    }
    if let Some(need) = constraints
        .get(&tokens.len().saturating_sub(1))
        .and_then(|v| v.get("regrip_after"))
        .filter(|v| **v != false)
    {
        let mut terminal = vec![];
        for old in frontier {
            for h in ["L", "R"] {
                for to in HOLDS {
                    let from = if h == "L" { &old.holds.0 } else { &old.holds.1 };
                    if let Some(rg) = c.regrip(h, from, to) {
                        if !matches_regrip(need, Some(rg)) { continue; }
                        let mut new = old.clone();
                        new.path.push(rg.key.clone());
                        if h == "L" {
                            new.holds.0 = to.into();
                        } else {
                            new.holds.1 = to.into();
                        }
                        terminal.push(new);
                    }
                }
            }
        }
        frontier = terminal;
    }
    Ok(
        json!({"alg":alg,"candidates":frontier.iter().map(|v|json!({"path":v.path,"initial_holds":holds(&v.initial),"proxy_score":v.heuristic})).collect::<Vec<_>>(),"expanded":expanded,"beam":beam}),
    )
}
