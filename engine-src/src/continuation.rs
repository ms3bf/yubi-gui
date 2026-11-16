//! Decode untrusted continuation JSON before any scheduling or feature extraction.
//! Validation does not rewrite the original JSON or its floating point values.
use crate::catalog::{CHANNELS, Catalog, HOLDS};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Deserialize)]
struct Pose {
    end: f64,
    pose: Value,
    hold: String,
    frame: [[i32; 3]; 3],
    last_event: Option<String>,
}
#[derive(Deserialize)]
struct Event {
    id: String,
    kind: String,
    start: f64,
    end: f64,
    from_pose: Value,
    to_pose: Value,
    from_hold: String,
    to_hold: String,
    from_frame: [[i32; 3]; 3],
    to_frame: [[i32; 3]; 3],
}
#[derive(Deserialize)]
struct Finger {
    #[serde(flatten)]
    snapshot: Pose,
    projected: Pose,
    pending: Vec<Event>,
    active: Vec<Event>,
}
#[derive(Deserialize)]
struct Reservation {
    start: f64,
    end: f64,
    action_start: f64,
    axis: String,
    layers: Vec<i32>,
    whole_cube: bool,
}
#[derive(Deserialize)]
struct State {
    t: f64,
    hold: BTreeMap<String, String>,
    projected_hold: BTreeMap<String, String>,
    fingers: BTreeMap<String, Finger>,
    cube_frame: [[i32; 3]; 3],
    hand_busy: BTreeMap<String, f64>,
    cube_reservations: Vec<Reservation>,
    generation: i64,
    last_was_regrip: bool,
    params: Value,
    catalog_version: String,
}
fn require(ok: bool, field: &str) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err(format!("Invalid continuation state: {field}"))
    }
}
fn time(v: f64) -> bool {
    v.is_finite() && v >= 0.0
}
fn frame(m: &[[i32; 3]; 3]) -> bool {
    if m.iter().flatten().any(|v| !(-1..=1).contains(v)) {
        return false;
    }
    for i in 0..3 {
        for j in 0..3 {
            if (0..3).map(|k| m[i][k] * m[j][k]).sum::<i32>() != i32::from(i == j) {
                return false;
            }
        }
    }
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
        == 1
}
fn pose_id(c: &Catalog, key: &str, v: &Value) -> bool {
    v.is_null()
        || v.as_str()
            .is_some_and(|s| c.data["pose_bindings"].get(format!("{key}:{s}")).is_some())
}
fn pose(c: &Catalog, key: &str, p: &Pose) -> Result<(), String> {
    require(
        time(p.end)
            && HOLDS.contains(&p.hold.as_str())
            && frame(&p.frame)
            && pose_id(c, key, &p.pose)
            && p.last_event.as_ref().is_none_or(|s| !s.is_empty()),
        key,
    )
}
fn event(c: &Catalog, key: &str, e: &Event) -> Result<(), String> {
    require(
        !e.id.is_empty()
            && ["recovery", "regrip", "carry", "stroke", "manual"].contains(&e.kind.as_str())
            && time(e.start)
            && time(e.end)
            && e.start <= e.end
            && HOLDS.contains(&e.from_hold.as_str())
            && HOLDS.contains(&e.to_hold.as_str())
            && frame(&e.from_frame)
            && frame(&e.to_frame)
            && pose_id(c, key, &e.from_pose)
            && pose_id(c, key, &e.to_pose),
        &format!("{key}.pending/active"),
    )
}
pub fn validate(c: &Catalog, params: &Value, incoming: &Value) -> Result<(), String> {
    let state: State = serde_json::from_value(incoming.clone())
        .map_err(|e| format!("Invalid continuation state: {e}"))?;
    require(time(state.t), "t")?;
    require(frame(&state.cube_frame), "cube_frame")?;
    require((0..i64::MAX).contains(&state.generation), "generation")?;
    let _ = state.last_was_regrip;
    require(
        state.catalog_version == c.data["version"],
        "catalog_version",
    )?;
    require(
        crate::deterministic::python_equal(&state.params, params),
        "params",
    )?;
    for (name, holds) in [
        ("hold", &state.hold),
        ("projected_hold", &state.projected_hold),
    ] {
        require(
            holds.len() == 2
                && ["L", "R"]
                    .iter()
                    .all(|h| holds.get(*h).is_some_and(|v| HOLDS.contains(&v.as_str()))),
            name,
        )?;
    }
    require(
        state.hand_busy.len() == 2
            && ["L", "R"]
                .iter()
                .all(|h| state.hand_busy.get(*h).is_some_and(|v| time(*v))),
        "hand_busy",
    )?;
    require(
        state.fingers.len() == 12,
        "fingers (all 12 resources required)",
    )?;
    for h in ["L", "R"] {
        for f in CHANNELS {
            let key = format!("{h}.{f}");
            let finger = state
                .fingers
                .get(&key)
                .ok_or_else(|| format!("Invalid continuation state: missing {key}"))?;
            pose(c, &key, &finger.snapshot)?;
            pose(c, &key, &finger.projected)?;
            for e in finger.pending.iter().chain(&finger.active) {
                event(c, &key, e)?;
            }
        }
    }
    for r in &state.cube_reservations {
        let _ = r.whole_cube;
        require(
            time(r.start)
                && time(r.end)
                && time(r.action_start)
                && r.action_start <= r.start
                && r.start <= r.end
                && ["x", "y", "z"].contains(&r.axis.as_str())
                && !r.layers.is_empty()
                && r.layers.len() <= 3
                && r.layers.iter().all(|v| (-1..=1).contains(v))
                && r.layers
                    .iter()
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
                    == r.layers.len(),
            "cube_reservations",
        )?;
    }
    Ok(())
}

/// Keep the exact scheduling maxima and startup-history predicate, without
/// carrying a growing list of completed reservations through every continuation.
pub fn compact(cube: &mut Vec<Value>, t: f64) {
    let mut keep = std::collections::BTreeSet::new();
    let mut maxima: BTreeMap<String, usize> = BTreeMap::new();
    let mut latest = None;
    let mut positive = None;
    for (i, r) in cube.iter().enumerate() {
        let end = r["end"].as_f64().unwrap();
        let start = r["start"].as_f64().unwrap();
        if end > t {
            keep.insert(i);
            continue;
        }
        if latest.is_none_or(|j: usize| start > cube[j]["start"].as_f64().unwrap()) {
            latest = Some(i);
        }
        if end > start {
            positive = Some(i);
        }
        let mut layers = r["layers"].as_array().unwrap().clone();
        layers.sort_by_key(|v| v.as_i64().unwrap());
        let key = format!(
            "{}:{}:{}",
            r["axis"],
            serde_json::json!(layers),
            r["whole_cube"]
        );
        if maxima
            .get(&key)
            .is_none_or(|j| end > cube[*j]["end"].as_f64().unwrap())
        {
            maxima.insert(key, i);
        }
    }
    keep.extend(maxima.values().copied());
    keep.extend(latest);
    keep.extend(positive);
    let mut i = 0;
    cube.retain(|_| {
        let retained = keep.contains(&i);
        i += 1;
        retained
    });
}
