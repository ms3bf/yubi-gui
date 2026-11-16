use crate::catalog::{Action, Catalog, HOLDS};
use crate::model::Model;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
#[derive(Clone, Debug)]
pub struct State {
    pub holds: Value,
    pub pl: usize,
    pub pr: usize,
    pub last: usize,
    pub rg: usize,
    pub since: usize,
    pub t: usize,
}
#[derive(Clone)]
pub struct Event {
    pub aid: usize,
    pub prev: [usize; 2],
    pub pos: usize,
    pub dyns: Vec<f32>,
    pub pair: Vec<f32>,
    pub base: f32,
}
pub struct Features<'a> {
    pub c: &'a Catalog,
    pub keys: Vec<String>,
    pub ids: BTreeMap<String, usize>,
    pub mids: BTreeMap<String, usize>,
    pub base: Vec<f32>,
    pub owned: Vec<BTreeSet<String>>,
    pub drive: Vec<BTreeSet<String>>,
}
pub fn hi(holds: &Value, h: &str) -> usize {
    HOLDS.iter().position(|v| holds[h] == *v).unwrap()
}
pub fn f16(x: f32) -> f32 {
    half::f16::from_f32(x).to_f32()
}
impl<'a> Features<'a> {
    pub fn new(c: &'a Catalog, bundle: &Value) -> Self {
        let keys: Vec<String> = serde_json::from_value(bundle["keys"].clone()).unwrap();
        let ids = keys
            .iter()
            .enumerate()
            .map(|(i, k)| (k.clone(), i))
            .collect();
        let moves: Vec<String> = serde_json::from_value(bundle["move_vocab"].clone()).unwrap();
        let mut mids: BTreeMap<_, _> = moves
            .iter()
            .enumerate()
            .map(|(i, k)| (k.clone(), i))
            .collect();
        for (k, i) in mids.clone() {
            if k.ends_with('2') {
                mids.entry(format!("{k}'")).or_insert(i);
            }
        }
        let base = crate::model::floats(&bundle["base"]["data"]);
        let mut owned = vec![BTreeSet::new(); base.len()];
        let mut drive = owned.clone();
        for (i, k) in keys.iter().enumerate().skip(1) {
            let a = c.get(k).unwrap();
            owned[i] = a.owned().into_iter().collect();
            drive[i] = owned[i]
                .iter()
                .filter(|r| a.driving.iter().any(|v| v == r.split_once('.').unwrap().1))
                .cloned()
                .collect();
        }
        Self {
            c,
            keys,
            ids,
            mids,
            base,
            owned,
            drive,
        }
    }
    pub fn action(&self, id: usize) -> &Action {
        self.c.get(&self.keys[id]).unwrap()
    }
    pub fn initial(&self, holds: Value) -> State {
        State {
            holds,
            pl: 0,
            pr: 0,
            last: 0,
            rg: 0,
            since: 4,
            t: 0,
        }
    }
    pub fn root_id(&self, holds: &Value) -> usize {
        self.keys.len() + hi(holds, "L") * 5 + hi(holds, "R")
    }
    pub fn root_event(&self, holds: &Value) -> Event {
        let mut dyns = vec![0.0; 16];
        dyns[0] = hi(holds, "L") as f32 / 4.0;
        dyns[1] = hi(holds, "R") as f32 / 4.0;
        dyns[7] = 1.0;
        dyns[3] = 1.0;
        let aid = self.root_id(holds);
        Event {
            aid,
            prev: [0, 0],
            pos: 0,
            dyns,
            pair: vec![0.0; 12],
            base: self.base[aid],
        }
    }
    pub fn pair(&self, previous: usize, aid: usize) -> Vec<f32> {
        let a = self.action(aid);
        let b = if previous > 0 {
            Some(self.action(previous))
        } else {
            None
        };
        let (bo, ao, bd, ad) = (
            &self.owned[previous],
            &self.owned[aid],
            &self.drive[previous],
            &self.drive[aid],
        );
        vec![
            b.is_some_and(|b| b.hand == a.hand) as u8 as f32,
            ao.intersection(bo).count() as f32 / 12.0,
            ad.intersection(bd).count() as f32 / 10.0,
            ad.intersection(bo).count() as f32 / 10.0,
            bd.intersection(ao).count() as f32 / 10.0,
            b.is_some_and(|b| b.axis == a.axis) as u8 as f32,
            b.is_some_and(|b| b.layers.iter().any(|v| a.layers.contains(v))) as u8 as f32,
            (a.before != a.after) as u8 as f32,
            (a.mv == "REGRIP") as u8 as f32,
            b.is_some_and(|b| b.mv == "REGRIP") as u8 as f32,
            a.whole_cube as u8 as f32,
            a.components.len() as f32 / 3.0,
        ]
    }
    pub fn step(&self, state: &State, aid: usize, n: usize) -> Result<(State, Event), String> {
        let a = self.action(aid);
        let norm = n.max(1) as f64;
        let isrg = a.mv == "REGRIP";
        let dyns = vec![
            hi(&state.holds, "L") as f64 / 4.0,
            hi(&state.holds, "R") as f64 / 4.0,
            state.t as f64 / norm,
            n.saturating_sub(state.t) as f64 / norm,
            state.rg as f64 / norm,
            state.since.min(4) as f64 / 4.0,
            isrg as u8 as f64,
            0.0,
            (a.hand == "BOTH") as u8 as f64,
            a.required_wrist_pose.is_some() as u8 as f64,
            self.drive[aid].len() as f64 / 10.0,
            self.owned[aid].len() as f64 / 12.0,
            (a.before != a.after) as u8 as f64,
            a.components.len() as f64 / 3.0,
            a.whole_cube as u8 as f64,
            (self.base[aid] / n.max(1) as f32) as f64,
        ]
        .into_iter()
        .map(|v| v as f32)
        .collect();
        let holds = a.next_holds(&state.holds)?;
        let pl = if ["L", "BOTH"].contains(&a.hand.as_str())
            || self.owned[aid].iter().any(|r| r.starts_with("L."))
        {
            aid
        } else {
            state.pl
        };
        let pr = if ["R", "BOTH"].contains(&a.hand.as_str())
            || self.owned[aid].iter().any(|r| r.starts_with("R."))
        {
            aid
        } else {
            state.pr
        };
        let event = Event {
            aid,
            prev: [state.pl, state.pr],
            pos: state.t.min(n.saturating_sub(1)),
            dyns,
            pair: self.pair(state.last, aid),
            base: self.base[aid],
        };
        Ok((
            State {
                holds,
                pl,
                pr,
                last: aid,
                rg: state.rg + usize::from(isrg),
                since: if isrg { 0 } else { state.since + 1 },
                t: state.t + usize::from(!isrg),
            },
            event,
        ))
    }
    pub fn encode_one(&self, route: &Value, alg: &str) -> Result<Value, String> {
        let tokens = crate::path::parse(alg, 500)?;
        let n = tokens.len();
        let norm = n.max(1) as f64;
        let initial = &route["initial_holds"];
        let rid = self.root_id(initial);
        let mut state = self.initial(initial.clone());
        let mut events = vec![self.root_event(initial)];
        let mut ids = vec![];
        for key in route["path"].as_array().ok_or("Invalid route")? {
            let aid = self.ids[key.as_str().unwrap()];
            let (next, event) = self.step(&state, aid, n)?;
            state = next;
            events.push(event);
            ids.push(aid);
        }
        let mut pairhash = vec![0.0f32; 64];
        let mut previous = rid;
        for id in &ids {
            let h = (previous as u64 * 73856093) ^ (*id as u64 * 19349663);
            pairhash[(h % 64) as usize] += if (h >> 6) & 1 != 0 { 1.0 } else { -1.0 };
            previous = *id;
        }
        for v in &mut pairhash {
            *v /= n.max(1) as f32;
        }
        let acts: Vec<_> = ids.iter().map(|i| self.action(*i)).collect();
        let rgidx: Vec<_> = acts
            .iter()
            .enumerate()
            .filter(|(_, a)| a.mv == "REGRIP")
            .map(|(i, _)| i)
            .collect();
        let initial_count = initial
            .as_object()
            .unwrap()
            .values()
            .filter(|h| *h != "F")
            .count();
        let mut spans = vec![];
        let mut hs = vec![];
        let mut remaining = vec![];
        for j in &rgidx {
            let a = acts[*j];
            let end = (*j + 1..acts.len())
                .find(|k| acts[*k].mv == "REGRIP" && acts[*k].hand == a.hand)
                .unwrap_or(acts.len());
            let seg: Vec<_> = acts[*j + 1..end]
                .iter()
                .filter(|v| v.mv != "REGRIP")
                .collect();
            spans.push(seg.len() as f64);
            hs.push(
                seg.iter()
                    .filter(|v| v.hand == a.hand || v.hand == "BOTH")
                    .count() as f64,
            );
            remaining
                .push(acts[*j + 1..].iter().filter(|v| v.mv != "REGRIP").count() as f64 / norm);
        }
        for hand in ["L", "R"] {
            if initial[hand] == "F" {
                continue;
            }
            let end = acts
                .iter()
                .position(|a| a.mv == "REGRIP" && a.hand == hand)
                .unwrap_or(acts.len());
            let seg: Vec<_> = acts[..end].iter().filter(|a| a.mv != "REGRIP").collect();
            spans.insert(0, seg.len() as f64);
            hs.insert(
                0,
                seg.iter()
                    .filter(|a| a.hand == hand || a.hand == "BOTH")
                    .count() as f64,
            );
            remaining.insert(0, 1.0);
        }
        let agg = |xs: &Vec<f64>| {
            vec![
                xs.iter().copied().reduce(f64::min).unwrap_or(0.0),
                xs.iter().fold(0.0, |s, x| s + x),
                xs.first().copied().unwrap_or(0.0),
            ]
        };
        let eq: [bool; 2] = [
            state.holds["L"] == initial["L"],
            state.holds["R"] == initial["R"],
        ];
        let turns: Vec<_> = acts.iter().filter(|a| a.mv != "REGRIP").collect();
        let mut vals = vec![
            n as f64,
            (rgidx.len() + initial_count) as f64,
            initial_count as f64,
            rgidx.len() as f64,
            (rgidx.iter().fold(0.0f32, |s, j| s + self.base[ids[*j]]) + self.base[rid]) as f64,
        ];
        vals.extend(agg(&spans));
        vals.extend(agg(&hs));
        vals.extend([
            remaining.last().copied().unwrap_or(0.0),
            rgidx
                .last()
                .is_some_and(|j| acts[*j + 1..].iter().filter(|v| v.mv != "REGRIP").count() <= 2)
                as u8 as f64,
            eq[0] as u8 as f64,
            eq[1] as u8 as f64,
            (eq[0] && eq[1]) as u8 as f64,
        ]);
        for h in ["L", "R"] {
            vals.push(
                acts.iter()
                    .filter(|a| a.hand == h && a.before != a.after)
                    .count() as f64,
            );
        }
        vals.extend([
            turns
                .windows(2)
                .filter(|ab| {
                    ab[0].hand == ab[1].hand
                        && ab[0].driving.iter().any(|f| ab[1].driving.contains(f))
                })
                .count() as f64,
            turns
                .windows(2)
                .filter(|ab| ab[0].hand == ab[1].hand)
                .count() as f64,
            turns
                .windows(2)
                .filter(|ab| ab[0].hand != ab[1].hand)
                .count() as f64,
            turns.iter().filter(|a| !a.components.is_empty()).count() as f64,
            turns.iter().filter(|a| a.whole_cube).count() as f64,
        ]);
        for b in 0..5 {
            vals.push(spans.iter().filter(|v| v.min(4.0) == b as f64).count() as f64);
        }
        vals.extend(agg(&remaining));
        vals.push(initial_count as f64);
        assert_eq!(vals.len(), 32);
        let mut stats: Vec<f32> = vals.iter().map(|v| *v as f32).collect();
        for j in [
            0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 29,
            31,
        ] {
            // wasm's f32 log1p is one ULP high for log1p(6). Round the
            // binary64 result once to reproduce NumPy's binary32 feature.
            stats[j] = (stats[j].max(0.0) as f64).ln_1p() as f32;
        }
        Ok(
            json!({"a":[events.iter().map(|e|e.aid).collect::<Vec<_>>()],"prev":[events.iter().map(|e|e.prev).collect::<Vec<_>>()],"pos":[events.iter().map(|e|e.pos).collect::<Vec<_>>()],"dyn":[events.iter().map(|e|e.dyns.iter().copied().map(f16).collect::<Vec<_>>()).collect::<Vec<_>>()],"pair":[events.iter().map(|e|e.pair.iter().copied().map(f16).collect::<Vec<_>>()).collect::<Vec<_>>()],"base":[events.iter().map(|e|f16(e.base)).collect::<Vec<_>>()],"hash":[pairhash],"stats":[stats],"moves":tokens.iter().map(|t|self.mids[&t.mv]).collect::<Vec<_>>() }),
        )
    }
}
impl Event {
    pub fn score(&self, model: &Model, ctx: &[Vec<f32>]) -> f64 {
        model
            .event(
                self.aid,
                self.prev,
                &self.dyns.iter().copied().map(f16).collect::<Vec<_>>(),
                &self.pair.iter().copied().map(f16).collect::<Vec<_>>(),
                f16(self.base),
                &ctx[self.pos],
            )
            .0 as f64
    }
    pub fn json(&self) -> Value {
        json!([
            self.aid,
            self.prev[0],
            self.prev[1],
            self.pos,
            self.dyns,
            self.pair,
            self.base
        ])
    }
}
