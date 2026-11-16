use serde_json::{Value, json};
use std::collections::BTreeMap;
#[derive(Clone)]
pub struct Tensor {
    pub shape: Vec<usize>,
    pub data: Vec<f32>,
}
pub struct Model {
    pub t: BTreeMap<String, Tensor>,
    pub table: Vec<Vec<f32>>,
}
pub fn floats(v: &Value) -> Vec<f32> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_f64().unwrap() as f32)
        .collect()
}
pub fn rows(v: &Value) -> Vec<Vec<f32>> {
    v.as_array().unwrap().iter().map(floats).collect()
}
impl Model {
    pub fn new(bundle: &Value) -> Self {
        let t: BTreeMap<_, _> = bundle["tensors"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    Tensor {
                        shape: serde_json::from_value(v["shape"].clone()).unwrap(),
                        data: floats(&v["data"]),
                    },
                )
            })
            .collect();
        let mut model = Self { t, table: vec![] };
        if model.t.contains_key("action.weight") {
            let sem = &model.t["sem"];
            let emb = &model.t["action.weight"];
            model.table = (0..sem.shape[0])
                .map(|i| {
                    let mut row = model.linear(&sem.data[i * 24..(i + 1) * 24], "semantic");
                    for j in 0..16 {
                        row[j] += emb.data[i * 16 + j];
                    }
                    row
                })
                .collect();
        }
        model
    }
    pub fn linear(&self, x: &[f32], name: &str) -> Vec<f32> {
        let w = &self.t[&format!("{name}.weight")];
        let bias = self.t.get(&format!("{name}.bias"));
        (0..w.shape[0])
            .map(|i| {
                let mut sum = 0.0f32;
                for (j, v) in x.iter().enumerate() {
                    sum += *v * w.data[i * x.len() + j];
                }
                sum + bias.map(|b| b.data[i]).unwrap_or(0.0)
            })
            .collect()
    }
    pub fn dot_probe(&self, req: &Value) -> Value {
        let x = rows(&req["x"]);
        let target = rows(&req["expected"]);
        let name = req["name"].as_str().unwrap();
        let w = &self.t[&format!("{name}.weight")];
        let mut results = vec![];
        for fused in [false, true] {
            for block in [0, 64, 128, 192, 256, 384, 512, 1024] {
                for lanes in [1, 2, 4, 8, 16, 32] {
                    for tree in [false, true] {
                        let mut exact = 0;
                        let mut max_delta = 0.0f64;
                        for (row, t) in x.iter().zip(&target) {
                            for o in 0..t.len() {
                                let width = if block == 0 { row.len() } else { block };
                                let mut total = 0.0f32;
                                for start in (0..row.len()).step_by(width) {
                                    let mut acc = vec![0.0f32; lanes];
                                    for j in start..(start + width).min(row.len()) {
                                        let index = (j - start) % lanes;
                                        let weight = w.data[o * row.len() + j];
                                        acc[index] = if fused {
                                            row[j].mul_add(weight, acc[index])
                                        } else {
                                            acc[index] + row[j] * weight
                                        };
                                    }
                                    let val = if tree {
                                        let mut k = lanes / 2;
                                        while k > 0 {
                                            for i in 0..k {
                                                acc[i] += acc[i + k];
                                            }
                                            k /= 2;
                                        }
                                        acc[0]
                                    } else {
                                        acc.iter().fold(0.0, |s, x| s + x)
                                    };
                                    total += val;
                                }
                                if total.to_bits() == t[o].to_bits() {
                                    exact += 1;
                                }
                                max_delta = max_delta.max((total as f64 - t[o] as f64).abs());
                            }
                        }
                        results.push(json!({"fused":fused,"block":block,"lanes":lanes,"tree":tree,"exact":exact,"total":x.len()*target[0].len(),"max_delta":max_delta}));
                    }
                }
            }
        }
        results.sort_by_key(|v| std::cmp::Reverse(v["exact"].as_u64().unwrap()));
        json!(results[..20])
    }
    fn conv(&self, x: &[Vec<f32>], name: &str, pad: i32, dilation: i32) -> Vec<Vec<f32>> {
        let w = &self.t[&format!("{name}.weight")];
        let bias = &self.t[&format!("{name}.bias")];
        (0..x.len())
            .map(|pos| {
                (0..w.shape[0])
                    .map(|o| {
                        let mut sum = 0.0f32;
                        for ch in 0..w.shape[1] {
                            for k in 0..w.shape[2] {
                                let j = pos as i32 - pad + k as i32 * dilation;
                                if j >= 0 && (j as usize) < x.len() {
                                    sum += x[j as usize][ch]
                                        * w.data[(o * w.shape[1] + ch) * w.shape[2] + k];
                                }
                            }
                        }
                        (sum + bias.data[o]).max(0.0)
                    })
                    .collect()
            })
            .collect()
    }
    pub fn contexts(&self, moves: &[usize]) -> Vec<Vec<f32>> {
        let emb = &self.t["move.weight"];
        let x: Vec<_> = moves
            .iter()
            .map(|i| emb.data[i * 8..i * 8 + 8].to_vec())
            .collect();
        let h = self.conv(&x, "conv.0", 1, 1);
        self.conv(&h, "conv.2", 2, 2)
    }
    pub fn event(
        &self,
        aid: usize,
        prev: [usize; 2],
        dyns: &[f32],
        pair: &[f32],
        base: f32,
        ctx: &[f32],
    ) -> (f32, Vec<f32>, f32) {
        let mut x = Vec::with_capacity(48);
        for id in prev {
            x.extend_from_slice(&self.table[id][..8]);
        }
        x.extend_from_slice(ctx);
        x.extend_from_slice(dyns);
        let h: Vec<_> = self
            .linear(&x, "query.0")
            .into_iter()
            .map(|v| v.max(0.0))
            .collect();
        let q = self.linear(&h, "query.2");
        let interaction: Vec<_> = q.iter().zip(&self.table[aid]).map(|(a, b)| a * b).collect();
        // ATen's contiguous last-dimension sum uses four vector accumulators
        // on supported CPU builds. Keep the scalar implementation measurable.
        let total = interaction.iter().fold(0.0f32, |v, x| v + x);
        let correction = (total / 4.0 + self.linear(pair, "pair")[0]).tanh();
        (base * (1.0 + 0.8 * correction), interaction, correction)
    }
    pub fn events_fixture(&self, req: &Value) -> Value {
        let mut local = vec![];
        let mut interactions = vec![];
        let mut corrections = vec![];
        for (i, aid) in req["a"].as_array().unwrap().iter().enumerate() {
            let prev = serde_json::from_value(req["prev"][i].clone()).unwrap();
            let (l, v, c) = self.event(
                aid.as_u64().unwrap() as usize,
                prev,
                &floats(&req["dyn"][i]),
                &floats(&req["pair"][i]),
                req["base"][i].as_f64().unwrap() as f32,
                &floats(&req["ctx"][i]),
            );
            local.push(l);
            interactions.push(v);
            corrections.push(c);
        }
        json!({"local":local,"interaction":interactions,"correction":corrections})
    }
    pub fn teacher(
        &self,
        features: &[Vec<f32>],
        costs: &[f32],
        n: usize,
        transform: &Value,
    ) -> Vec<f32> {
        let offset = transform["offset"].as_u64().unwrap() as usize;
        let mean = floats(&transform["mean"]);
        let std = floats(&transform["std"]);
        features
            .iter()
            .zip(costs)
            .map(|(x, cost)| {
                let mut x = x.clone();
                for i in 0..mean.len() {
                    x[offset + i] = (x[offset + i] - mean[i]) / std[i];
                }
                let h: Vec<_> = self
                    .linear(&x, "net.0")
                    .into_iter()
                    .map(|v| v / (1.0 + (-v.clamp(-80.0, 80.0)).exp()))
                    .collect();
                *cost / n as f32 + self.linear(&h, "net.3")[0]
            })
            .collect()
    }
    pub fn forward(&self, b: &Value) -> Value {
        let moves: Vec<usize> = serde_json::from_value(b["moves"].clone()).unwrap();
        let ctx = self.contexts(&moves);
        let n = moves.iter().filter(|i| **i != 0).count().max(1) as f32;
        let mut scores = vec![];
        let mut globals = vec![];
        let mut locals = vec![];
        let mut corrections = vec![];
        for (i, ids) in b["a"].as_array().unwrap().iter().enumerate() {
            let mut local = vec![];
            let mut corr = vec![];
            let mut sum = 0.0f32;
            let mut mean = vec![0.0f32; 16];
            let mut mx = vec![-1e9f32; 16];
            let mut count = 0;
            for (j, aid) in ids.as_array().unwrap().iter().enumerate() {
                let aid = aid.as_u64().unwrap() as usize;
                let (l, v, c) = self.event(
                    aid,
                    serde_json::from_value(b["prev"][i][j].clone()).unwrap(),
                    &floats(&b["dyn"][i][j]),
                    &floats(&b["pair"][i][j]),
                    b["base"][i][j].as_f64().unwrap() as f32,
                    &ctx[b["pos"][i][j].as_u64().unwrap() as usize],
                );
                local.push(l);
                corr.push(c);
                if aid != 0 {
                    sum += l;
                    count += 1;
                    for k in 0..16 {
                        mean[k] += v[k];
                        mx[k] = mx[k].max(v[k]);
                    }
                }
            }
            for v in &mut mean {
                *v /= count.max(1) as f32;
            }
            let mut x = mean;
            x.extend(mx);
            x.extend(floats(&b["hash"][i]));
            x.extend(floats(&b["stats"][i]));
            let mut h = self.linear(&x, "rank.0");
            for v in &mut h {
                *v /= 1.0 + (-*v).exp();
            }
            let mut result = self.linear(&h, "rank.2");
            if self.t.contains_key("rank.4.weight") {
                for v in &mut result {
                    *v /= 1.0 + (-*v).exp();
                }
                result = self.linear(&result, "rank.4");
            }
            let g = sum / n;
            scores.push(g + result[0]);
            globals.push(g);
            locals.push(local);
            corrections.push(corr);
        }
        json!([scores, globals, locals, corrections])
    }
}
