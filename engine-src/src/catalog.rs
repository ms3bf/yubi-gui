use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
pub const HOLDS: [&str; 5] = ["B_CW", "U", "F", "D", "B_CCW"];
pub const FINGERS: [&str; 5] = ["thumb", "index", "middle", "ring", "pinky"];
pub const CHANNELS: [&str; 6] = ["thumb", "index", "middle", "ring", "pinky", "wrist"];
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Action {
    pub key: String,
    pub action_id: String,
    pub hand: String,
    #[serde(rename = "move")]
    pub mv: String,
    pub before: String,
    pub after: String,
    pub finger: String,
    pub direction: i32,
    pub d_class: String,
    pub resources: Vec<String>,
    pub driving: Vec<String>,
    pub start: Map<String, Value>,
    pub end: Map<String, Value>,
    pub axis: Option<String>,
    pub layers: Vec<i32>,
    pub clip: String,
    pub whole_cube: bool,
    pub components: Vec<Value>,
    pub stroke: String,
    pub clip_duration: f64,
    pub awk: f64,
    pub supporting: Vec<String>,
    pub repositioning: Vec<String>,
    pub preserve: Vec<String>,
    pub wrist_moves: bool,
    pub drive_fraction: f64,
    pub operation: Option<Value>,
    pub required_wrist_pose: Option<String>,
    pub authored_move: String,
}
impl Action {
    pub fn execution(&self) -> &str {
        self.operation
            .as_ref()
            .and_then(|x| x["execution"].as_str())
            .unwrap_or("")
    }
    pub fn owned(&self) -> Vec<String> {
        if self.execution() == "hold_only" {
            return vec![];
        }
        if self.execution() == "authored_companion" {
            return self.operation.as_ref().unwrap()["resources"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().into())
                .collect();
        }
        let hands = if self.whole_cube {
            vec!["L", "R"]
        } else {
            vec![self.hand.as_str()]
        };
        if self.whole_cube || self.mv == "REGRIP" {
            hands
                .into_iter()
                .flat_map(|h| FINGERS.map(|f| format!("{h}.{f}")))
                .collect()
        } else {
            self.resources
                .iter()
                .filter(|f| f.as_str() != "wrist")
                .map(|f| format!("{}.{f}", self.hand))
                .collect()
        }
    }
    pub fn next_holds(&self, holds: &Value) -> Result<Value, String> {
        let mut out = holds.clone();
        if let Some(op) = &self.operation {
            match self.execution() {
                "authored_companion" => {
                    if op["required_holds"]
                        .as_object()
                        .unwrap()
                        .iter()
                        .any(|(h, v)| holds[h] != *v)
                    {
                        return Err(format!("Illegal companion hold: {}", self.key));
                    }
                    for (h, v) in op["to_holds"].as_object().unwrap() {
                        out[h] = v.clone();
                    }
                }
                "hold_only" => {
                    out = Value::Object(Map::new());
                    let step = if self.mv == "x'" { 1 } else { -1 };
                    for (h, chain) in op["hold_chains"].as_object().unwrap() {
                        let values = chain.as_array().unwrap();
                        let j = values
                            .iter()
                            .position(|v| *v == holds[h])
                            .ok_or("Invalid hold")? as i32
                            + step;
                        if j < 0 || j >= values.len() as i32 {
                            return Err(format!(
                                "Hold-chain boundary: {h} {}",
                                holds[h].as_str().unwrap()
                            ));
                        }
                        out[h] = values[j as usize].clone();
                    }
                }
                _ => out = op["to_holds"].clone(),
            }
        } else {
            if holds[&self.hand] != self.before {
                return Err(format!("Illegal starting hold: {}", self.key));
            }
            out[&self.hand] = self.after.clone().into();
        }
        Ok(out)
    }
    pub fn matches(&self, t: &crate::path::Token) -> bool {
        crate::path::equivalent(&self.mv) == crate::path::equivalent(&t.mv)
            && (!t.mv.contains('3') || self.authored_move == t.mv)
            && t.direction_hint.is_none_or(|d| d == self.direction)
    }
}
pub struct Catalog {
    pub actions: Vec<Action>,
    pub indices: BTreeMap<String, usize>,
    pub data: Value,
}
impl Catalog {
    pub fn new(data: &Value) -> Result<Self, String> {
        let actions: Vec<Action> =
            serde_json::from_value(data["actions"].clone()).map_err(|e| e.to_string())?;
        let indices = actions
            .iter()
            .enumerate()
            .map(|(i, a)| (a.key.clone(), i))
            .collect();
        Ok(Self {
            actions,
            indices,
            data: data.clone(),
        })
    }
    pub fn get(&self, key: &str) -> Result<&Action, String> {
        self.indices
            .get(key)
            .map(|i| &self.actions[*i])
            .ok_or_else(|| format!("Unknown action: {key}"))
    }
    pub fn regrip(&self, hand: &str, before: &str, after: &str) -> Option<&Action> {
        self.actions
            .iter()
            .find(|a| a.mv == "REGRIP" && a.hand == hand && a.before == before && a.after == after)
    }
    pub fn home(&self, hand: &str, hold: &str, finger: &str) -> Value {
        self.data["homes"][format!("{hand}__{hold}")][finger].clone()
    }
    pub fn bindings(&self, lanes: &Value) -> Value {
        let mut keys = std::collections::BTreeSet::new();
        for (r, events) in lanes.as_object().unwrap() {
            for e in events.as_array().unwrap() {
                for f in ["from_pose", "to_pose"] {
                    if let Some(p) = e[f].as_str() {
                        keys.insert(format!("{r}:{p}"));
                    }
                }
            }
        }
        let mut out = Map::new();
        for key in keys {
            out.insert(key.clone(), self.data["pose_bindings"][&key].clone());
        }
        out.into()
    }
}
