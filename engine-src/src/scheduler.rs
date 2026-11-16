use crate::catalog::{Action, CHANNELS, Catalog, FINGERS, HOLDS};
use crate::path;
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;
fn n(v: &Value) -> f64 {
    v.as_f64().unwrap()
}
fn s(v: &Value) -> &str {
    v.as_str().unwrap()
}
fn a(v: &Value) -> &Vec<Value> {
    v.as_array().unwrap()
}
fn push(v: &mut Value, x: Value) {
    v.as_array_mut().unwrap().push(x);
}
fn intersects<T: PartialEq>(a: &[T], b: &[T]) -> bool {
    a.iter().any(|v| b.contains(v))
}
fn merge(v: &mut Value, extra: Value) {
    for (k, x) in extra.as_object().unwrap() {
        v[k] = x.clone();
    }
}
pub fn coordinated_ud(a: &Action, b: &Action) -> bool {
    let moves = ["U", "U'", "D", "D'"];
    a.hand == b.hand
        && ["L", "R"].contains(&a.hand.as_str())
        && moves.contains(&a.mv.as_str())
        && moves.contains(&b.mv.as_str())
        && a.mv.as_bytes()[0] != b.mv.as_bytes()[0]
        && [&a.before, &a.after, &b.before, &b.after]
            .iter()
            .all(|v| v.as_str() == "F")
        && !(a.whole_cube
            || b.whole_cube
            || !a.components.is_empty()
            || !b.components.is_empty()
            || a.wrist_moves
            || b.wrist_moves)
        && a.supporting.iter().any(|f| f == "thumb")
        && b.supporting.iter().any(|f| f == "thumb")
        && !intersects(&a.driving, &b.driving)
        && !intersects(&a.repositioning, &b.resources)
        && !intersects(&b.repositioning, &a.resources)
}
pub fn shared_support(a: &Action, b: &Action) -> Vec<String> {
    if a.hand != b.hand
        || !["L", "R"].contains(&a.hand.as_str())
        || a.whole_cube
        || b.whole_cube
        || !a.components.is_empty()
        || !b.components.is_empty()
        || a.wrist_moves
        || b.wrist_moves
        || a.mv == "REGRIP"
        || b.mv == "REGRIP"
        || a.before != a.after
        || b.before != b.after
        || a.after != b.before
        || a.axis != b.axis
        || intersects(&a.layers, &b.layers)
    {
        return vec![];
    }
    if intersects(&a.driving, &b.resources)
        || intersects(&a.repositioning, &b.resources)
        || intersects(&b.driving, &a.resources)
        || intersects(&b.repositioning, &a.resources)
    {
        return vec![];
    }
    a.supporting
        .iter()
        .filter(|f| b.supporting.contains(f))
        .map(|f| format!("{}.{f}", a.hand))
        .collect()
}
pub fn segments(act: &Action, duration: f64) -> Result<Vec<Value>, String> {
    if act.execution() == "hold_only" {
        return Ok(vec![]);
    }
    if !act.components.is_empty() {
        let mut result = vec![];
        for stage in &act.components {
            let mv = s(&stage["move"]);
            let (ax, ls) = path::layers(mv);
            let u0 = n(&stage["start"]) / act.clip_duration;
            let u1 = n(&stage["end"]) / act.clip_duration;
            if !(0.0 <= u0 && u0 < u1 && u1 <= 1.0 + 1e-8) {
                return Err("Invalid component phase".into());
            }
            let mut angle = path::angle(mv, None);
            if mv.contains('2') {
                angle = (stage.get("angle").map(n).unwrap_or(angle) / (std::f64::consts::PI / 2.0))
                    .round_ties_even()
                    * (std::f64::consts::PI / 2.0);
            }
            result.push(json!({"offset":u0*duration,"finish":u1.min(1.0)*duration,"axis":ax,"layers":ls,"move":mv,"angle":angle,"u_start":u0,"u_end":u1.min(1.0)}));
        }
        Ok(result)
    } else {
        Ok(vec![
            json!({"offset":act.drive_fraction*duration,"finish":duration,"axis":act.axis,"layers":act.layers,"move":act.mv,"angle":path::angle(&act.mv,Some(act.direction)),"u_start":act.drive_fraction,"u_end":1.0}),
        ])
    }
}
pub fn validate_entry(
    c: &Catalog,
    keys: &[String],
    initial: &Value,
    incoming: Option<&Value>,
) -> Result<(), String> {
    if !keys
        .iter()
        .any(|k| c.get(k).is_ok_and(|a| a.required_wrist_pose.is_some()))
    {
        return Ok(());
    }
    let mut holds = initial.clone();
    let mut wrists = json!({});
    for h in ["L", "R"] {
        wrists[h] = incoming
            .map(|v| v["fingers"][format!("{h}.wrist")]["projected"]["pose"].clone())
            .unwrap_or_else(|| c.home(h, s(&holds[h]), "wrist"));
    }
    for key in keys {
        let act = c.get(key)?;
        if act
            .required_wrist_pose
            .as_ref()
            .is_some_and(|p| wrists[&act.hand] != *p)
        {
            return Err(format!(
                "Required incoming wrist pose (after DU slide): {key}"
            ));
        }
        let next = act.next_holds(&holds)?;
        if let Some(op) = &act.operation {
            for h in ["L", "R"] {
                wrists[h] = if act.execution() == "hold_only" {
                    Value::Null
                } else {
                    op["end"][format!("{h}.wrist")].clone()
                };
            }
        } else if act.mv == "REGRIP" {
            wrists[&act.hand] = c.home(&act.hand, s(&next[&act.hand]), "wrist");
        } else if let Some(w) = act.end.get("wrist") {
            wrists[&act.hand] = w.clone();
        }
        holds = next;
    }
    Ok(())
}
fn frame(v: &Value) -> [[i32; 3]; 3] {
    serde_json::from_value(v.clone()).unwrap()
}
pub fn schedule(c: &Catalog, params: &Value, request: &Value) -> Result<Value, String> {
    let p = params;
    let incoming = request
        .get("initial_state")
        .filter(|v| !v.is_null());
    let prepared = request["prepared"].as_bool().unwrap_or(false);
    let start_ff = request["start_from_ff"].as_bool().unwrap_or(true);
    let mut initial = request
        .get("initial_holds")
        .filter(|v| !v.is_null())
        .cloned();
    if let Some(inc) = incoming {
        crate::continuation::validate(c, params, inc)?;
        if prepared {
            return Err("Cannot declare a running state prepared".into());
        }
        if !crate::deterministic::python_equal(&inc["params"],p) {
            return Err("Cannot change parameters during an in-flight motion plan".into());
        }
        if inc["catalog_version"] != c.data["version"] {
            return Err("Continuation state has a different catalog version".into());
        }
        let projected = inc.get("projected_hold").unwrap_or(&inc["hold"]);
        if initial.as_ref().is_some_and(|h| h != projected) {
            return Err("Initial holds disagree with continuation state".into());
        }
        initial = Some(projected.clone());
    }
    let initial = initial.unwrap_or(json!({"L":"F","R":"F"}));
    if initial.as_object().is_none_or(|o| o.len() != 2)
        || !["L", "R"]
            .iter()
            .all(|h| initial[*h].as_str().is_some_and(|v| HOLDS.contains(&v)))
    {
        return Err("Invalid initial holds".into());
    }
    let mut holds = initial.clone();
    let keys: Vec<String> =
        serde_json::from_value(request["path"].clone()).map_err(|_| "Invalid path")?;
    if let Some(ms) = request.get("duration_multipliers") {
        if ms.as_object().is_none_or(|m| {
            m.iter().any(|(i, v)| {
                i.parse::<usize>().ok().is_none_or(|i| i >= keys.len())
                    || v.as_f64()
                        .is_none_or(|v| !v.is_finite() || !(0.75..=1.35).contains(&v))
            })
        }) {
            return Err("Invalid display duration multiplier".into());
        }
    }
    validate_entry(c, &keys, &holds, incoming)?;
    let mut initial_wrists = json!({});
    for h in holds.as_object().unwrap().keys() {
        initial_wrists[h] = incoming
            .map(|v| v["fingers"][format!("{h}.wrist")]["projected"]["pose"].clone())
            .unwrap_or_else(|| c.home(h, s(&holds[h]), "wrist"));
    }
    let mut actions: Vec<Action> = keys
        .iter()
        .map(|k| c.get(k).cloned())
        .collect::<Result<_, _>>()?;
    let mut released = vec![BTreeSet::<String>::new(); actions.len()];
    for i in 0..actions.len().saturating_sub(1) {
        let (a, b) = (&actions[i], &actions[i + 1]);
        if coordinated_ud(a, b) {
            released[i].extend(
                a.supporting
                    .iter()
                    .filter(|f| b.driving.contains(f))
                    .cloned(),
            );
            released[i + 1].extend(
                b.supporting
                    .iter()
                    .filter(|f| a.driving.contains(f))
                    .cloned(),
            );
        }
    }
    for (i, act) in actions.iter_mut().enumerate() {
        act.resources.retain(|f| !released[i].contains(f));
        act.supporting.retain(|f| !released[i].contains(f));
    }
    let mut check = holds.clone();
    for (i, act) in actions.iter().enumerate() {
        let following = act.next_holds(&check)?;
        if i > 0
            && act.mv == "REGRIP"
            && actions[i - 1].mv == "REGRIP"
            && act.hand == actions[i - 1].hand
        {
            return Err("Consecutive regrips".into());
        }
        if i == 0 && incoming.is_some_and(|v| v["last_was_regrip"] == true) && act.mv == "REGRIP" {
            return Err("Consecutive regrips across continuation boundary".into());
        }
        check = following;
    }
    let mut lanes = json!({});
    let mut state = json!({});
    let pose_frame = json!(path::IDENTITY);
    let origin = incoming.map(|v| n(&v["t"])).unwrap_or(0.0);
    let mut cube_frame = incoming
        .and_then(|v| v.get("cube_frame"))
        .cloned()
        .unwrap_or_else(|| pose_frame.clone());
    let generation = incoming
        .map(|v| v["generation"].as_i64().unwrap_or(0) + 1)
        .unwrap_or(0);
    for h in ["L", "R"] {
        for f in CHANNELS {
            let key = format!("{h}.{f}");
            lanes[&key] = json!([]);
            state[&key] = json!({"end":0.0,"pose":c.home(h,s(&holds[h]),f),"last_event":null,"hold":holds[h],"frame":pose_frame});
            if let Some(inc) = incoming {
                state[&key] = inc["fingers"][&key]["projected"].clone();
                let end = n(&state[&key]["end"]).max(origin);
                state[&key]["end"] = json!(end);
                lanes[&key] = inc["fingers"][&key]
                    .get("pending")
                    .cloned()
                    .unwrap_or(json!([]));
            }
        }
    }
    let mut moves = vec![];
    let mut regrips = vec![];
    let mut action_events: Vec<Value> = vec![];
    let mut hand_busy = incoming
        .and_then(|v| v.get("hand_busy"))
        .cloned()
        .unwrap_or(json!({"L":origin,"R":origin}));
    let mut cube: Vec<Value> = incoming
        .and_then(|v| v["cube_reservations"].as_array())
        .cloned()
        .unwrap_or_default();
    let mut t_turn_end = origin;
    let mut previous_start = cube
        .iter()
        .map(|v| n(&v["start"]))
        .reduce(f64::max)
        .unwrap_or(origin);
    if start_ff && incoming.is_none() {
        let mut setup_end = 0.0f64;
        for h in ["L", "R"] {
            if holds[h] == "F" {
                continue;
            }
            let act = c
                .regrip(h, "F", s(&holds[h]))
                .ok_or("Missing initial regrip")?;
            let end = n(&p["g_initial"]);
            setup_end = setup_end.max(end);
            let eid = format!("g{generation}:setup:{h}");
            regrips.push(json!({"id":eid,"path_index":if h=="L"{-2}else{-1},"action_id":act.action_id,"key":act.key,"hand":h,"move":"REGRIP","hold_before":"F","hold_after":holds[h],"start":0.0,"end":end,"wait":0.0,"wait_cause":[],"clip":act.clip,"resources":act.owned(),"roles":{},"i":0,"initial_setup":true}));
            for f in CHANNELS {
                push(
                    &mut lanes[format!("{h}.{f}")],
                    json!({"id":format!("{eid}:{f}"),"event_id":eid,"kind":"regrip","start":0.0,"end":end,"from_pose":c.home(h,"F",f),"to_pose":c.home(h,s(&holds[h]),f),"from_frame":pose_frame,"to_frame":pose_frame,"from_hold":"F","to_hold":holds[h],"clip":null,"role":"supporting","initial_setup":true}),
                );
            }
        }
        for v in state.as_object_mut().unwrap().values_mut() {
            v["end"] = json!(setup_end);
        }
        hand_busy = json!({"L":setup_end,"R":setup_end});
    }
    for (index, act) in actions.iter().enumerate() {
        let eid = format!("g{generation}:action:{index}");
        let companion = act.execution() == "authored_companion";
        let owned = act.owned();
        let wrists: Vec<_> = ["L", "R"]
            .into_iter()
            .filter(|h| act.whole_cube || companion || *h == act.hand)
            .map(|h| format!("{h}.wrist"))
            .collect();
        let following = act.next_holds(&holds)?;
        if act.execution() == "hold_only" {
            let t = t_turn_end
                .max(origin)
                .max(n(&hand_busy["L"]))
                .max(n(&hand_busy["R"]));
            let after_frame = json!(path::rotate(frame(&cube_frame), &act.mv, act.direction));
            let segment = json!({"start":t,"end":t,"offset":0.0,"finish":0.0,"axis":act.axis,"layers":act.layers,"angle":path::angle(&act.mv,Some(act.direction)),"move":act.mv,"u_start":0.0,"u_end":1.0,"instant":true});
            let event = json!({"id":eid,"path_index":index,"key":act.key,"action_id":act.action_id,"hand":"BOTH","move":act.mv,"start":t,"end":t,"wait":0.0,"wait_cause":[],"resources":[],"cube_segments":[segment],"clip":null,"d_class":"hold_only","holds_before":holds,"holds_after":following,"hold_before":holds,"hold_after":following,"execution":"hold_only","whole_cube":true,"cube_frame_before":cube_frame,"cube_frame_after":after_frame,"notation_transform":act.mv,"roles":{},"preparation":false,"animation":"none","i":moves.len()});
            moves.push(event.clone());
            action_events.push(event);
            holds = following;
            for (key, v) in state.as_object_mut().unwrap() {
                v["hold"] = holds[&key[..1]].clone();
                v["hold_only"] = json!(true);
            }
            t_turn_end = t;
            cube_frame = after_frame;
            cube.push(json!({"start":t,"end":t,"axis":act.axis,"layers":act.layers,"whole_cube":true,"action_start":t}));
            previous_start = t;
            continue;
        }
        let before_frame = cube_frame.clone();
        let after_frame = if act.whole_cube {
            json!(path::rotate(frame(&before_frame), &act.mv, act.direction))
        } else {
            before_frame.clone()
        };
        let mut ready: Map<String, Value> = Map::new();
        let shared: Vec<String> = if index > 0 {
            shared_support(&actions[index - 1], act)
                .into_iter()
                .filter(|key| {
                    state[key]["last_event"] == format!("g{generation}:action:{}", index - 1)
                })
                .collect()
        } else {
            vec![]
        };
        ready.insert(
            format!("hand:{}", act.hand),
            if act.operation.is_some() {
                json!(n(&hand_busy["L"]).max(n(&hand_busy["R"])))
            } else {
                hand_busy[&act.hand].clone()
            },
        );
        for key in &owned {
            let (h, f) = key.split_once('.').unwrap();
            let previous = &state[key];
            if shared.contains(key) {
                ready.insert(
                    format!("finger:{key}"),
                    action_events.last().unwrap()["start"].clone(),
                );
                continue;
            }
            let mut target = if act.operation.is_some() {
                previous["pose"].clone()
            } else if h == act.hand {
                act.start.get(f).unwrap_or(&previous["pose"]).clone()
            } else {
                previous["pose"].clone()
            };
            if companion {
                target = act.operation.as_ref().unwrap()["start"][key].clone();
            }
            let target_frame = if h == act.hand && act.start.contains_key(f) {
                pose_frame.clone()
            } else {
                previous["frame"].clone()
            };
            let equal =
                previous["pose"] == target && (f != "wrist" || previous["frame"] == target_frame);
            let duration = if equal || (prepared && previous["last_event"].is_null()) {
                0.0
            } else {
                n(&p["r_default"][f])
            };
            let start = origin.max(n(&previous["end"]));
            let end = start + duration;
            if duration != 0.0 {
                push(
                    &mut lanes[key],
                    json!({"id":format!("g{generation}:transfer:{index}:{key}"),"kind":"recovery","start":start,"end":end,"from_pose":previous["pose"],"to_pose":target,"from_frame":previous["frame"],"to_frame":target_frame,"target_action":act.key,"from_hold":previous["hold"],"to_hold":if h==act.hand{json!(act.before)}else{holds[h].clone()},"reason":if previous["last_event"].is_null(){"initial_preparation"}else{"next_use"}}),
                );
            }
            ready.insert(format!("finger:{key}"), json!(end));
        }
        let is_rg = act.mv == "REGRIP";
        let duration;
        let mut segs = vec![];
        if is_rg {
            ready.insert(
                format!("hand:{}", act.hand),
                json!(
                    FINGERS
                        .iter()
                        .map(|f| n(&state[format!("{}.{f}", act.hand)]["end"]))
                        .reduce(f64::max)
                        .unwrap()
                ),
            );
            let delta = (HOLDS.iter().position(|h| *h == act.before).unwrap() as i32
                - HOLDS.iter().position(|h| *h == act.after).unwrap() as i32)
                .abs();
            duration = n(&p["g"][if delta == 1 { "adjacent" } else { "far" }]);
        } else {
            duration = n(&p["d"][&act.d_class])
                * request
                    .get("duration_multipliers")
                    .and_then(|ms| ms.get(index.to_string()))
                    .map(n)
                    .unwrap_or(1.0);
            segs = segments(act, duration)?;
            let mut cube_ready = previous_start;
            for old in &cube {
                for segment in &segs {
                    let t = if act.whole_cube || old["whole_cube"] == true {
                        n(&old["end"])
                    } else if old["axis"] == segment["axis"] {
                        if intersects(a(&old["layers"]), a(&segment["layers"])) {
                            n(&old["end"]) - n(&segment["offset"])
                        } else {
                            previous_start
                        }
                    } else {
                        n(&old["end"]) - n(&segment["offset"])
                    };
                    cube_ready = cube_ready.max(t);
                }
            }
            ready.insert("cube".into(), json!(cube_ready));
        }
        let mut start = origin.max(ready.values().map(n).reduce(f64::max).unwrap_or(origin));
        let mut causes: Vec<String> = ready
            .iter()
            .filter(|(_, v)| n(v) > 0.0 && (n(v) - start).abs() < 1e-9)
            .map(|(k, _)| k.clone())
            .collect();
        let wait = if is_rg {
            0.0
        } else {
            0.0f64.max(start - t_turn_end)
        };
        if !is_rg && (!cube.iter().any(|e| n(&e["end"]) > n(&e["start"])) || wait > 1e-9) {
            start += n(&p["s"]);
            if n(&p["s"]) != 0.0 {
                causes.push("startup".into());
            }
        }
        let end = start + duration;
        let mut event = json!({"id":eid,"path_index":index,"action_id":act.action_id,"key":act.key,"hand":act.hand,"move":act.mv,"hold_before":act.before,"hold_after":act.after,"start":start,"end":end,"wait":wait,"wait_cause":causes,"clip":act.clip,"d_class":act.d_class,"resources":owned,"cube_frame_before":before_frame,"cube_frame_after":after_frame,"whole_cube":act.whole_cube,"opposite_hand_policy":if act.whole_cube{json!("carry_with_cube")}else{Value::Null},"roles":{"driving":act.driving,"supporting":act.supporting,"repositioning":act.repositioning,"preserve":act.preserve,"wrist_moves":act.wrist_moves},"i":moves.len(),"coordinated_support_release":released[index],"holds_before":holds,"holds_after":following});
        if let Some(op) = &act.operation {
            merge(
                &mut event,
                json!({"execution":op["execution"],"manual_controls":op["manual_controls"],"opposite_hand_policy":if companion{"authored_companion"}else{"both_manual"}}),
            );
        }
        event["notation_frame"] = json!("fixed_physical_faces");
        event["ready_times"] = Value::Object(ready.clone());
        let mut resource_wait = Map::new();
        for key in &owned {
            resource_wait.insert(
                key.clone(),
                json!(0.0f64.max(
                    n(&ready[&format!("finger:{key}")])
                        - origin.max(ready.get("cube").map(n).unwrap_or(origin))
                )),
            );
        }
        event["resource_wait"] = resource_wait.into();
        if !is_rg {
            event["cube_segments"] = json!(
                segs.iter()
                    .map(|v| {
                        let mut v = v.clone();
                        let b = start + n(&v["offset"]);
                        let e = start + n(&v["finish"]);
                        v["start"] = json!(b);
                        v["end"] = json!(e);
                        v
                    })
                    .collect::<Vec<_>>()
            );
        }
        for key in owned.iter().chain(&wrists) {
            let (h, f) = key.split_once('.').unwrap();
            let old = state[key].clone();
            if shared.contains(key) {
                if end > n(&old["end"]) {
                    push(
                        &mut lanes[key],
                        json!({"id":format!("g{generation}:support:{index}:{key}"),"kind":"carry","start":start.max(n(&old["end"])),"end":end,"event_id":eid,"clip":null,"from_pose":old["pose"],"to_pose":old["pose"],"from_frame":old["frame"],"to_frame":old["frame"],"from_hold":old["hold"],"to_hold":old["hold"],"role":"supporting","exclusive":true}),
                    );
                }
                state[key]["end"] = json!(n(&old["end"]).max(end));
                state[key]["last_event"] = json!(eid);
                if event.get("shared_support").is_none() {
                    event["shared_support"] = json!([]);
                }
                push(&mut event["shared_support"], json!(key));
                continue;
            }
            let op = act.operation.as_ref();
            let authored = if companion {
                op.unwrap()["end"].get(key).is_some()
            } else {
                h == act.hand && act.end.contains_key(f)
            };
            let mut role = if authored {
                if act.driving.iter().any(|v| v == f) {
                    "driving"
                } else if act.supporting.iter().any(|v| v == f) {
                    "supporting"
                } else if act.repositioning.iter().any(|v| v == f) {
                    "repositioning"
                } else if f == "wrist" && act.wrist_moves {
                    "wrist_motion"
                } else if f == "wrist" {
                    "anchor"
                } else {
                    "preserve"
                }
            } else {
                "preserve"
            }
            .to_string();
            let mut end_pose = if op.is_some() {
                c.home(h, s(&following[h]), f)
            } else if authored {
                act.end[f].clone()
            } else {
                old["pose"].clone()
            };
            if op.is_some() {
                role = if f == "wrist" {
                    "wrist_motion"
                } else {
                    "supporting"
                }
                .into();
            }
            if companion {
                end_pose = op.unwrap()["end"][key].clone();
                role = s(&op.unwrap()["roles"][key]).into();
            }
            let end_frame = if op.is_some() || authored {
                pose_frame.clone()
            } else {
                old["frame"].clone()
            };
            let new_hold = &following[h];
            push(
                &mut lanes[key],
                json!({"id":format!("g{generation}:stroke:{index}:{key}"),"kind":if companion{"stroke"}else if op.is_some(){"manual"}else if is_rg{"regrip"}else if authored{"stroke"}else{"carry"},"start":start,"end":end,"event_id":eid,"clip":if companion{op.unwrap()["clips"][h].clone()}else if authored{json!(act.clip)}else{Value::Null},"from_pose":if companion{op.unwrap()["start"][key].clone()}else if authored{act.start[f].clone()}else{old["pose"].clone()},"to_pose":end_pose,"from_frame":if authored{pose_frame.clone()}else{old["frame"].clone()},"to_frame":end_frame,"from_hold":if h==act.hand{json!(act.before)}else{holds[h].clone()},"to_hold":new_hold,"role":role,"exclusive":f!="wrist"}),
            );
            state[key] = json!({"end":end,"pose":end_pose,"last_event":eid,"hold":new_hold,"frame":end_frame});
        }
        action_events.push(event.clone());
        if is_rg {
            regrips.push(event);
        } else {
            moves.push(event);
        }
        holds = following;
        if act.whole_cube || companion {
            hand_busy = json!({"L":end,"R":end});
        } else if is_rg || act.before != act.after || !act.components.is_empty() {
            hand_busy[&act.hand] = json!(end);
        }
        if !is_rg {
            for v in segs {
                cube.push(json!({"start":start+n(&v["offset"]),"end":start+n(&v["finish"]),"axis":v["axis"],"layers":v["layers"],"whole_cube":act.whole_cube,"action_start":start}));
            }
            previous_start = start;
            t_turn_end = t_turn_end.max(end);
        }
        cube_frame = after_frame;
    }
    for (key, previous) in state.as_object().unwrap() {
        let (h, f) = key.split_once('.').unwrap();
        let home = c.home(h, s(&previous["hold"]), f);
        if f != "wrist"
            && previous["hold_only"] != true
            && !previous["last_event"].is_null()
            && previous["pose"] != home
        {
            push(
                &mut lanes[key],
                json!({"id":format!("g{generation}:home:{key}"),"kind":"recovery","start":previous["end"],"end":n(&previous["end"])+n(&p["r_default"][f]),"from_pose":previous["pose"],"to_pose":home,"from_frame":previous["frame"],"to_frame":pose_frame,"from_hold":previous["hold"],"to_hold":previous["hold"],"reason":"terminal_home"}),
            );
        }
    }
    for (key, events) in lanes.as_object_mut().unwrap() {
        let es = events.as_array_mut().unwrap();
        es.sort_by(|x, y| {
            n(&x["start"])
                .total_cmp(&n(&y["start"]))
                .then(n(&x["end"]).total_cmp(&n(&y["end"])))
                .then(s(&x["id"]).cmp(s(&y["id"])))
        });
        if !key.ends_with(".wrist")
            && es
                .windows(2)
                .any(|e| n(&e[0]["end"]) > n(&e[1]["start"]) + 1e-9)
        {
            return Err("Resource double booking".into());
        }
    }
    let mut t_motion_end = t_turn_end;
    for events in lanes.as_object().unwrap().values() {
        for e in a(events) {
            t_motion_end = t_motion_end.max(n(&e["end"]));
        }
    }
    let mut t_task_end = t_turn_end;
    for e in &regrips {
        t_task_end = t_task_end.max(n(&e["end"]));
    }
    let mut end_fingers = json!({});
    for (key, events) in lanes.as_object().unwrap() {
        let events = a(events);
        let pending: Vec<Value> = events
            .iter()
            .filter(|e| n(&e["start"]) <= t_task_end && t_task_end < n(&e["end"]))
            .cloned()
            .collect();
        let completed: Vec<&Value> = events
            .iter()
            .filter(|e| n(&e["end"]) <= t_task_end && e["kind"] == "recovery")
            .collect();
        let mut snapshot = state[key].clone();
        if let Some(last) = completed.last() {
            if n(&last["end"]) >= n(&snapshot["end"]) {
                merge(
                    &mut snapshot,
                    json!({"pose":last["to_pose"],"end":last["end"],"frame":last["to_frame"]}),
                );
            }
        }
        if let Some(ev) = pending.first() {
            snapshot["pose"] = Value::Null;
            snapshot["progress"] =
                json!((t_task_end - n(&ev["start"])) / (n(&ev["end"]) - n(&ev["start"])));
        }
        let mut projected = state[key].clone();
        if let Some(last) = events.last() {
            if projected["hold_only"] != true && n(&last["end"]) >= n(&projected["end"]) {
                merge(
                    &mut projected,
                    json!({"end":last["end"],"pose":last["to_pose"],"hold":last["to_hold"],"frame":last["to_frame"]}),
                );
            }
        }
        merge(
            &mut snapshot,
            json!({"active":pending,"projected":projected,"pending":events.iter().filter(|e|n(&e["end"])>t_task_end).collect::<Vec<_>>() }),
        );
        end_fingers[key] = snapshot;
    }
    let mut actual_holds = incoming
        .map(|v| v["hold"].clone())
        .unwrap_or(initial.clone());
    if let Some(inc) = incoming {
        for h in ["L", "R"] {
            let mut pending: Vec<&Value> = inc["fingers"]
                .as_object()
                .unwrap()
                .iter()
                .filter(|(key, _)| key.starts_with(&format!("{h}.")))
                .flat_map(|(_, v)| v.get("pending").map(a).into_iter().flatten())
                .filter(|e| n(&e["end"]) <= t_task_end)
                .collect();
            pending.sort_by(|x, y| n(&x["end"]).total_cmp(&n(&y["end"])));
            for ev in pending {
                actual_holds[h] = ev["to_hold"].clone();
            }
        }
    }
    action_events.sort_by(|x, y| {
        n(&x["end"])
            .total_cmp(&n(&y["end"]))
            .then(s(&x["id"]).cmp(s(&y["id"])))
    });
    for ev in action_events {
        if n(&ev["end"]) <= t_task_end {
            merge(&mut actual_holds, ev["holds_after"].clone());
        }
    }
    let awk = actions.iter().fold(0.0, |sum, v| sum + v.awk);
    if awk < 0.0 {
        return Err("Negative awkwardness".into());
    }
    let mut clip_hashes = Map::new();
    for events in lanes.as_object().unwrap().values() {
        for e in a(events) {
            if let Some(clip) = e["clip"].as_str() {
                if let Some(hash) = c.data["hashes"].get(clip) {
                    clip_hashes.insert(clip.into(), hash.clone());
                }
            }
        }
    }
    crate::continuation::compact(&mut cube, t_task_end);
    Ok(
        json!({"schema_version":2,"relative_time":true,"cost":t_task_end-origin+n(&p["lambda_awk"])*awk,"awk":awk,"origin":origin,"cost_basis":"requested_action_makespan_excluding_terminal_returns","t_end":t_task_end,"t_turn_end":t_turn_end,"t_task_end":t_task_end,"t_motion_end":t_motion_end,"bursts":usize::from(!moves.is_empty())+moves.iter().skip(1).filter(|m|n(&m["wait"])>1e-9).count(),"initial_holds":initial,"path":keys,"moves":moves,"regrips":regrips,"lanes":lanes,"initial_wrist_poses":initial_wrists,"pose_bindings":c.bindings(&lanes),"clip_hashes":clip_hashes,"end_state":{"hold":actual_holds,"projected_hold":holds,"fingers":end_fingers,"t":t_task_end,"cube_frame":cube_frame,"cube_reservations":cube,"params":p,"generation":generation,"hand_busy":hand_busy,"catalog_version":c.data["version"],"last_was_regrip":actions.last().is_some_and(|v|v.mv=="REGRIP")},"limitations":["explicit_user_finger_constraints","manual_bimanual_motion_requires_authored_controls","continuation_finishes_committed_returns_before_retargeting"]}),
    )
}
