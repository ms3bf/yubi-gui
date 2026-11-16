use crate::{
    catalog::{Action, Catalog},
    path, scheduler,
};
use serde_json::{Value, json};
pub fn independent(a: &Action, b: &Action) -> bool {
    if a.operation.is_some()
        || b.operation.is_some()
        || a.whole_cube
        || b.whole_cube
        || !a.components.is_empty()
        || !b.components.is_empty()
    {
        return false;
    }
    if a.mv == "REGRIP" || b.mv == "REGRIP" {
        return a.hand != b.hand;
    }
    if a.before != a.after
        || b.before != b.after
        || a.axis != b.axis
        || a.layers.iter().any(|v| b.layers.contains(v))
    {
        return false;
    }
    a.hand != b.hand
        || !a.resources.iter().any(|v| b.resources.contains(v))
        || !scheduler::shared_support(a, b).is_empty()
        || scheduler::coordinated_ud(a, b)
}
pub type Identity = ((String, String), Vec<String>);
pub fn identity(route: &Value) -> Identity {
    (
        (
            route["initial_holds"]["L"].as_str().unwrap().into(),
            route["initial_holds"]["R"].as_str().unwrap().into(),
        ),
        serde_json::from_value(route["path"].clone()).unwrap(),
    )
}
pub fn normalize(c: &Catalog, p: &Value, route: &Value) -> Result<Value, String> {
    let keys: Vec<String> =
        serde_json::from_value(route["path"].clone()).map_err(|_| "Invalid path")?;
    let mut holds = route["initial_holds"].clone();
    let protected = route
        .get("protected_rg")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut items: Vec<(String, bool)> = keys
        .iter()
        .enumerate()
        .map(|(i, k)| (k.clone(), protected.contains(&json!(i))))
        .collect();
    let (mut folded, mut removed, mut swapped) = (0, 0, 0);
    let original = path::state(
        &keys
            .iter()
            .map(|k| c.get(k).unwrap())
            .filter(|a| a.mv != "REGRIP")
            .map(|a| a.mv.clone())
            .collect::<Vec<_>>(),
    );
    let plan = |items: &[(String, bool)], holds: &Value| {
        scheduler::schedule(
            c,
            p,
            &json!({"path":items.iter().map(|v|&v.0).collect::<Vec<_>>(),"initial_holds":holds}),
        )
    };
    for _ in 0..(keys.len() * keys.len() + 1).max(1) {
        let mut changed = false;
        while items
            .first()
            .is_some_and(|v| c.get(&v.0).unwrap().mv == "REGRIP")
        {
            let a = c.get(&items.remove(0).0)?;
            holds = a.next_holds(&holds)?;
            folded += 1;
            changed = true;
        }
        let current = plan(&items, &holds)?;
        for i in (0..items.len()).rev() {
            let (k, guard) = &items[i];
            let a = c.get(k)?;
            if *guard || a.mv != "REGRIP" {
                continue;
            }
            if items[i + 1..]
                .iter()
                .map(|v| c.get(&v.0).unwrap())
                .any(|v| v.hand == a.hand || v.operation.is_some() || v.whole_cube)
            {
                continue;
            }
            let mut trial = items.clone();
            trial.remove(i);
            if let Ok(other) = plan(&trial, &holds) {
                if (other["cost"].as_f64().unwrap() - current["cost"].as_f64().unwrap()).abs()
                    <= 1e-9
                {
                    items = trial;
                    removed += 1;
                    changed = true;
                    break;
                }
            }
        }
        if changed {
            continue;
        }
        let mut starts = std::collections::BTreeMap::new();
        for e in current["moves"]
            .as_array()
            .unwrap()
            .iter()
            .chain(current["regrips"].as_array().unwrap())
        {
            if e["initial_setup"] != true {
                starts.insert(
                    e["path_index"].as_i64().unwrap(),
                    e["start"].as_f64().unwrap(),
                );
            }
        }
        for i in 0..items.len().saturating_sub(1) {
            let (a, b) = (c.get(&items[i].0)?, c.get(&items[i + 1].0)?);
            let allowed = (starts.get(&(i as i64)).unwrap_or(&-1.0)
                - starts.get(&(i as i64 + 1)).unwrap_or(&-2.0))
            .abs()
                < 1e-8;
            if (a.mv != "REGRIP", &a.key) <= (b.mv != "REGRIP", &b.key)
                || !allowed
                || !independent(a, b)
            {
                continue;
            }
            let mut trial = items.clone();
            trial.swap(i, i + 1);
            if plan(&trial, &holds).is_err() {
                continue;
            }
            let other = path::state(
                &trial
                    .iter()
                    .map(|v| c.get(&v.0).unwrap())
                    .filter(|a| a.mv != "REGRIP")
                    .map(|a| a.mv.clone())
                    .collect::<Vec<_>>(),
            );
            if original != other {
                continue;
            }
            items = trial;
            swapped += 1;
            changed = true;
            break;
        }
        if !changed {
            return Ok(
                json!({"path":items.iter().map(|v|&v.0).collect::<Vec<_>>(),"initial_holds":holds,"protected_rg":items.iter().enumerate().filter(|(_,v)|v.1).map(|(i,_)|i).collect::<Vec<_>>(),"normalization":{"folded":folded,"removed":removed,"swapped":swapped}}),
            );
        }
    }
    Err("Canonicalization did not converge".into())
}
pub fn tie_key(c: &Catalog, p: &Value, route: &Value) -> Result<(usize, usize, Identity), String> {
    let r = normalize(c, p, route)?;
    let mut previous = std::collections::BTreeMap::new();
    let (mut switches, mut rg) = (0, 0);
    for k in r["path"].as_array().unwrap() {
        let a = c.get(k.as_str().unwrap())?;
        if a.mv == "REGRIP" {
            rg += 1;
            continue;
        }
        let fingers = if a.driving.is_empty() {
            vec!["wrist".into()]
        } else {
            a.driving.clone()
        };
        if previous.get(&a.hand).is_some_and(|v| *v != fingers) {
            switches += 1;
        }
        previous.insert(a.hand.clone(), fingers);
    }
    Ok((rg, switches, identity(&r)))
}
