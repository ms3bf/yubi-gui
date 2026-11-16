use crate::deterministic::HashMap;
use crate::{
    catalog::{Action, Catalog},
    scheduler,
};
use blake2::{
    Blake2bVar,
    digest::{Update, VariableOutput},
};
use serde_json::{Value, json};
fn n(v: &Value) -> f64 {
    v.as_f64().unwrap()
}
fn pybool(v: bool) -> &'static str {
    if v { "True" } else { "False" }
}
fn category(a: &Action) -> String {
    format!(
        "{}:{}:{}:{}",
        a.d_class,
        if a.driving.is_empty() {
            "wrist".into()
        } else {
            a.driving.join(",")
        },
        a.before,
        a.after
    )
}
struct Values {
    entries: Vec<(String, f64)>,
    indices: HashMap<String, usize>,
    n: f64,
}
impl Values {
    fn add(&mut self, block: &str, key: String, value: f64) {
        let name = format!("{block}|{key}");
        let i = *self.indices.entry(name.clone()).or_insert_with(|| {
            self.entries.push((name, 0.0));
            self.entries.len() - 1
        });
        self.entries[i].1 += value / self.n;
    }
    fn encode(self) -> Vec<f32> {
        let mut out = vec![0.0f32; 4128];
        for (name, v) in self.entries {
            let (block, key) = name.split_once('|').unwrap();
            let (offset, width) = match block {
                "numeric" => (0, 32),
                "unary" => (32, 512),
                "shared" => (544, 512),
                "context" => (1056, 3072),
                _ => continue,
            };
            let mut hasher = Blake2bVar::new(8).unwrap();
            hasher.update(key.as_bytes());
            let mut digest = [0; 8];
            hasher.finalize_variable(&mut digest).unwrap();
            let i = offset + (u64::from_le_bytes(digest) % width) as usize;
            out[i] += v as f32;
        }
        out
    }
}
fn actions<'a>(c: &'a Catalog, r: &Value) -> Result<Vec<&'a Action>, String> {
    r["path"]
        .as_array()
        .ok_or("Invalid route")?
        .iter()
        .map(|k| c.get(k.as_str().unwrap()))
        .collect()
}
pub fn base(c: &Catalog, r: &Value, plan: &Value) -> Result<Vec<f32>, String> {
    let acts = actions(c, r)?;
    let turns: Vec<_> = acts.iter().copied().filter(|a| a.mv != "REGRIP").collect();
    let mut v = Values {
        entries: vec![],
        indices: HashMap::default(),
        n: turns.len().max(1) as f64,
    };
    v.add("numeric", "cost".into(), n(&plan["cost"]));
    v.add("numeric", "steps".into(), v.n);
    for (h, hold) in r["initial_holds"].as_object().unwrap() {
        v.add(
            "unary",
            format!("initial:{h}:{}", hold.as_str().unwrap()),
            1.0,
        );
    }
    for (i, a) in turns.iter().enumerate() {
        let choice = format!("{}:{}:{}", a.hand, a.driving.join(","), a.before);
        let at = |j: i32| {
            if j >= 0 && (j as usize) < turns.len() {
                turns[j as usize].mv.as_str()
            } else {
                "BOUNDARY"
            }
        };
        for distance in [-2, -1, 1, 2] {
            v.add(
                "context",
                format!("{distance}:{}/{}/{choice}", at(i as i32 + distance), a.mv),
                1.0,
            );
        }
        v.add(
            "context",
            format!(
                "surround:{}/{}/{}/{choice}",
                at(i as i32 - 1),
                a.mv,
                at(i as i32 + 1)
            ),
            1.0,
        );
        v.add(
            "context",
            format!(
                "same_next:{}/{}/{choice}",
                pybool(i + 1 < turns.len() && a.axis == turns[i + 1].axis),
                a.mv
            ),
            1.0,
        );
        v.add(
            "context",
            format!(
                "boundary:{}:{}/{}/{choice}",
                pybool(i == 0),
                pybool(i == turns.len() - 1),
                a.mv
            ),
            1.0,
        );
    }
    let mut last_hand: HashMap<&str, &Action> = HashMap::default();
    let mut last_resource: HashMap<String, &Action> = HashMap::default();
    for (i, a) in acts.iter().enumerate() {
        for key in [
            format!("action:{}", a.key),
            format!("class:{}", a.d_class),
            format!("driver:{}:{}", a.hand, a.driving.join(",")),
            format!("hold:{}:{}>{}", a.hand, a.before, a.after),
            format!("move_driver:{}:{}:{}", a.mv, a.hand, a.driving.join(",")),
        ] {
            v.add("unary", key, 1.0);
        }
        if let Some(b) = last_hand.get(a.hand.as_str()) {
            v.add(
                "shared",
                format!("same_hand:{}>{}", category(b), category(a)),
                1.0,
            );
            v.add(
                "shared",
                format!(
                    "same_hand_move:{}:{}>{}:{}",
                    b.mv,
                    b.driving.join(","),
                    a.mv,
                    a.driving.join(",")
                ),
                1.0,
            );
        }
        last_hand.insert(&a.hand, a);
        for resource in a.owned() {
            let finger = resource.split_once('.').unwrap().1;
            if let Some(b) = last_resource.get(&resource) {
                v.add(
                    "shared",
                    format!("next_resource:{finger}:{}>{}", b.d_class, a.d_class),
                    1.0,
                );
                if let (Some(old), Some(new)) = (b.end.get(finger), a.start.get(finger)) {
                    if !old.is_null() && !new.is_null() {
                        v.add(
                            "shared",
                            format!("pose_equal:{finger}:{}", pybool(old == new)),
                            1.0,
                        );
                    }
                }
            }
            last_resource.insert(resource, a);
        }
        if i > 0 {
            let b = acts[i - 1];
            v.add(
                "shared",
                format!(
                    "adjacent:{}:{}>{}",
                    if a.hand != b.hand { "cross" } else { "same" },
                    category(b),
                    category(a)
                ),
                1.0,
            );
        }
    }
    let mut events: Vec<_> = plan["moves"]
        .as_array()
        .unwrap()
        .iter()
        .chain(plan["regrips"].as_array().unwrap())
        .filter(|e| e["initial_setup"] != true)
        .collect();
    events.sort_by_key(|e| e["path_index"].as_i64().unwrap());
    for ev in &events {
        v.add(
            "numeric",
            "wait".into(),
            ev.get("wait").map(n).unwrap_or(0.0),
        );
        if let Some(rw) = ev["resource_wait"].as_object() {
            for (key, value) in rw {
                v.add("shared", format!("resource_wait:{key}"), n(value));
            }
        }
    }
    for (i, b) in events.iter().enumerate() {
        for a in &events[i + 1..] {
            let overlap =
                0.0f64.max(n(&a["end"]).min(n(&b["end"])) - n(&a["start"]).max(n(&b["start"])));
            if overlap != 0.0 && a["hand"] != b["hand"] {
                v.add("numeric", "cross_overlap".into(), overlap);
            }
        }
    }
    for (resource, lane) in plan["lanes"].as_object().unwrap() {
        for ev in lane.as_array().unwrap() {
            if ev["kind"] == "recovery" && ev["reason"] != "terminal_home" {
                let delta = n(&ev["end"]) - n(&ev["start"]);
                v.add("shared", format!("recovery:{resource}"), delta);
                v.add("numeric", "recovery_sum".into(), delta);
            }
        }
    }
    Ok(v.encode())
}
struct Counterfactual {
    valid: bool,
    required: bool,
    unknown: bool,
    failure: usize,
    t_end: f64,
}
fn cf(
    c: &Catalog,
    p: &Value,
    r: &Value,
    index: i64,
    hand: &str,
    incoming: Option<&Value>,
) -> Result<Counterfactual, String> {
    let mut initial = r["initial_holds"].clone();
    if index < 0 {
        initial[hand] = json!("F");
    }
    let mut holds = initial.clone();
    let mut keys = vec![];
    let mut failure = 0;
    let error = |required, unknown, failure| Counterfactual {
        valid: false,
        required,
        unknown,
        failure,
        t_end: 0.0,
    };
    for (i, a) in actions(c, r)?.into_iter().enumerate() {
        if i as i64 == index {
            continue;
        }
        let b = if a.mv == "REGRIP" {
            if holds[&a.hand] == a.after {
                continue;
            }
            c.regrip(&a.hand, holds[&a.hand].as_str().unwrap(), &a.after)
        } else if a.operation.is_some() {
            Some(a)
        } else {
            c.actions.iter().find(|b| {
                b.operation.is_none()
                    && b.mv != "REGRIP"
                    && b.hand == a.hand
                    && b.action_id == a.action_id
                    && holds[&a.hand] == b.before
            })
        };
        let Some(b) = b else {
            return Ok(error(true, false, failure));
        };
        if a.mv != "REGRIP"
            && (a.mv != b.mv || a.direction != b.direction || a.driving != b.driving)
        {
            return Ok(error(false, true, failure));
        }
        match b.next_holds(&holds) {
            Ok(h) => holds = h,
            Err(_) => return Ok(error(true, false, failure)),
        }
        keys.push(b.key.clone());
        if a.mv != "REGRIP" {
            failure += 1;
        }
    }
    match scheduler::schedule(
        c,
        p,
        &json!({"path":keys,"initial_holds":initial,"initial_state":incoming}),
    ) {
        Ok(plan) => Ok(Counterfactual {
            valid: true,
            required: false,
            unknown: false,
            failure: 0,
            t_end: n(&plan["t_end"]),
        }),
        Err(_) => Ok(error(false, true, failure)),
    }
}
pub fn regrip(
    c: &Catalog,
    p: &Value,
    r: &Value,
    plan: &Value,
    incoming: Option<&Value>,
) -> Result<Vec<f32>, String> {
    let acts = actions(c, r)?;
    let norm = acts.iter().filter(|a| a.mv != "REGRIP").count().max(1) as f64;
    let mut events: Vec<_> = plan["regrips"].as_array().unwrap().iter().collect();
    events.sort_by_key(|v| v["path_index"].as_i64().unwrap());
    let mut values = vec![];
    let mut durations = vec![];
    let mut details = vec![];
    for ev in events {
        let idx = ev["path_index"].as_i64().unwrap();
        let hand = ev["hand"].as_str().unwrap();
        let initial = ev["initial_setup"] == true
            || !acts[..idx.max(0) as usize].iter().any(|a| a.mv != "REGRIP");
        let start = (idx + 1).max(0) as usize;
        let end = (start..acts.len())
            .find(|j| acts[*j].mv == "REGRIP" && acts[*j].hand == hand)
            .unwrap_or(acts.len());
        let span: Vec<_> = acts[start..end]
            .iter()
            .filter(|a| a.mv != "REGRIP")
            .collect();
        let ns = span.len();
        let nh = span
            .iter()
            .filter(|a| a.hand == hand || a.whole_cube)
            .count();
        let duration = n(&ev["end"]) - n(&ev["start"]);
        let opposite = if hand == "L" { "R" } else { "L" };
        let mut intervals: Vec<_> = plan["moves"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| {
                m["hand"] == opposite
                    && n(&ev["end"]).min(n(&m["end"])) > n(&ev["start"]).max(n(&m["start"]))
            })
            .map(|m| {
                (
                    n(&ev["start"]).max(n(&m["start"])),
                    n(&ev["end"]).min(n(&m["end"])),
                )
            })
            .collect();
        intervals.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
        let (mut finish, mut total) = (f64::NEG_INFINITY, 0.0);
        for (a, b) in intervals {
            total += 0.0f64.max(b - a.max(finish));
            finish = finish.max(b);
        }
        let hidden = if initial {
            1.0
        } else if duration > 0.0 {
            1.0f64.min(total / duration)
        } else {
            0.0
        };
        let counter = cf(c, p, r, idx, hand, incoming)?;
        let saving = if counter.valid {
            counter.t_end - n(&plan["t_end"])
        } else {
            0.0
        };
        let remaining = acts[start..].iter().filter(|a| a.mv != "REGRIP").count();
        let mut row = vec![
            saving,
            counter.valid as u8 as f64,
            counter.required as u8 as f64,
            counter.unknown as u8 as f64,
            counter.failure as f64 / norm,
            ns as f64,
            nh as f64,
            hidden,
            initial as u8 as f64,
            remaining as f64 / norm,
        ];
        for count in [ns, nh] {
            for b in 0..5 {
                row.push((count.min(4) == b) as u8 as f64);
            }
        }
        values.push(row);
        durations.push(duration);
        details.push((idx, remaining));
    }
    let mut out = vec![];
    for col in 0..20 {
        let xs: Vec<_> = values.iter().map(|v| v[col]).collect();
        out.extend([
            xs.iter().copied().reduce(f64::min).unwrap_or(0.0),
            xs.iter().fold(0.0, |s, x| s + x),
            xs.first().copied().unwrap_or(0.0),
        ]);
    }
    let valid: Vec<_> = values
        .iter()
        .filter(|v| v[1] != 0.0)
        .map(|v| v[0])
        .collect();
    let eq: Vec<_> = ["L", "R"]
        .iter()
        .map(|h| plan["end_state"]["projected_hold"][*h] == r["initial_holds"][*h])
        .collect();
    out.extend([
        values.len() as f64,
        durations.iter().fold(0.0, |s, x| s + x),
        valid.iter().copied().reduce(f64::min).unwrap_or(0.0),
        (!valid.is_empty()) as u8 as f64,
        (!values.is_empty()) as u8 as f64,
        details.last().is_some_and(|(i, rem)| *i >= 0 && *rem <= 2) as u8 as f64,
        eq[0] as u8 as f64,
        eq[1] as u8 as f64,
        (eq[0] && eq[1]) as u8 as f64,
    ]);
    Ok(out.into_iter().map(|v| v as f32).collect())
}
pub fn extract(
    c: &Catalog,
    p: &Value,
    r: &Value,
    plan: &Value,
    incoming: Option<&Value>,
) -> Result<Vec<f32>, String> {
    let mut x = base(c, r, plan)?;
    x.extend(regrip(c, p, r, plan, incoming)?);
    Ok(x)
}
