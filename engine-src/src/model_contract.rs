//! Format-v1 architecture contract shared by WASM construction and the native runner.
use crate::{catalog::Catalog, path};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Deserialize)]
struct Tensor {
    shape: Vec<usize>,
    dtype: String,
    data: Vec<f64>,
}
fn tensor(v: &Value, name: &str) -> Result<Tensor, String> {
    let t: Tensor = serde_json::from_value(v.clone())
        .map_err(|e| format!("Invalid model tensor {name}: {e}"))?;
    let size = t.shape.iter().try_fold(1usize, |n, d| n.checked_mul(*d));
    if t.dtype != "float32"
        || t.shape.is_empty()
        || t.shape.contains(&0)
        || size != Some(t.data.len())
        || t.data
            .iter()
            .any(|n| !n.is_finite() || !(*n as f32).is_finite())
    {
        return Err(format!(
            "Invalid model tensor {name}: dtype, shape/data, or nonfinite value"
        ));
    }
    Ok(t)
}
fn tensors(b: &Value, label: &str) -> Result<BTreeMap<String, Tensor>, String> {
    b["tensors"]
        .as_object()
        .ok_or_else(|| format!("Missing {label}.tensors"))?
        .iter()
        .map(|(k, v)| tensor(v, &format!("{label}.{k}")).map(|t| (k.clone(), t)))
        .collect()
}
fn shape(t: &BTreeMap<String, Tensor>, key: &str, expected: &[usize]) -> Result<(), String> {
    if t.get(key).is_none_or(|v| v.shape != expected) {
        return Err(format!("Invalid model shape: {key}, expected {expected:?}"));
    }
    Ok(())
}
fn output(t: &BTreeMap<String, Tensor>, key: &str) -> Result<usize, String> {
    t.get(key)
        .and_then(|t| t.shape.first())
        .copied()
        .ok_or_else(|| format!("Missing model tensor {key}"))
}
fn linear(
    t: &BTreeMap<String, Tensor>,
    name: &str,
    input: usize,
    out: usize,
    bias: bool,
) -> Result<(), String> {
    shape(t, &format!("{name}.weight"), &[out, input])?;
    let key = format!("{name}.bias");
    if bias || t.contains_key(&key) {
        shape(t, &key, &[out])?;
    }
    Ok(())
}
pub fn validate(bundle: &Value, catalog: &Catalog) -> Result<(), String> {
    if bundle["schema_version"] != 1 {
        return Err("Unsupported bundle schema".into());
    }
    let b = &bundle["student"];
    let keys: Vec<String> =
        serde_json::from_value(b["keys"].clone()).map_err(|_| "Invalid student keys")?;
    let mut expected: Vec<_> = catalog.actions.iter().map(|a| a.key.clone()).collect();
    expected.sort();
    expected.insert(0, "PAD".into());
    if keys != expected {
        return Err("Student keys must match sorted catalog keys with PAD at index zero".into());
    }
    let moves: Vec<String> =
        serde_json::from_value(b["move_vocab"].clone()).map_err(|_| "Invalid move_vocab")?;
    let mut expected = BTreeSet::new();
    for a in &catalog.actions {
        if a.mv == "REGRIP" {
            continue;
        }
        for token in path::parse(
            if a.authored_move.is_empty() {
                &a.mv
            } else {
                &a.authored_move
            },
            500,
        )? {
            expected.insert(token.mv);
        }
    }
    let mut expected: Vec<_> = expected.into_iter().collect();
    expected.insert(0, "PAD".into());
    if moves != expected {
        return Err(
            "Student move_vocab must match sorted authored catalog moves with PAD at index zero"
                .into(),
        );
    }
    let t = tensors(b, "student")?;
    let count = keys
        .len()
        .checked_add(25)
        .ok_or("Student vocabulary too large")?;
    shape(&t, "sem", &[count, 24])?;
    shape(&t, "action.weight", &[count, 16])?;
    linear(&t, "semantic", 24, 16, false)?;
    shape(&t, "move.weight", &[moves.len(), 8])?;
    for (name, input) in [("conv.0", 8), ("conv.2", 16)] {
        shape(&t, &format!("{name}.weight"), &[16, input, 3])?;
        shape(&t, &format!("{name}.bias"), &[16])?;
    }
    let hidden = output(&t, "query.0.weight")?;
    linear(&t, "query.0", 48, hidden, true)?;
    linear(&t, "query.2", hidden, 16, true)?;
    linear(&t, "pair", 12, 1, false)?;
    let rank = output(&t, "rank.0.weight")?;
    linear(&t, "rank.0", 128, rank, true)?;
    let rank2 = if t.contains_key("rank.4.weight") {
        output(&t, "rank.2.weight")?
    } else {
        1
    };
    linear(&t, "rank.2", rank, rank2, true)?;
    if t.contains_key("rank.4.weight") {
        linear(&t, "rank.4", rank2, 1, true)?;
    }
    let base = tensor(&b["base"], "student.base")?;
    if base.shape != [count] {
        return Err("Invalid student.base shape (including 25 root hold pairs)".into());
    }
    let b = &bundle["teacher"];
    let t = tensors(b, "teacher")?;
    let hidden = output(&t, "net.0.weight")?;
    linear(&t, "net.0", 4197, hidden, true)?;
    linear(&t, "net.3", hidden, 1, false)?;
    let transform = &b["transform"];
    let offset = transform["offset"]
        .as_u64()
        .ok_or("Invalid teacher transform offset")?;
    let mean: Vec<f64> = serde_json::from_value(transform["mean"].clone())
        .map_err(|_| "Invalid teacher transform mean")?;
    let std: Vec<f64> = serde_json::from_value(transform["std"].clone())
        .map_err(|_| "Invalid teacher transform std")?;
    if offset != 4128
        || mean.len() != 69
        || std.len() != 69
        || mean.iter().any(|n| !(*n as f32).is_finite())
        || std
            .iter()
            .any(|n| !(*n as f32).is_finite() || (*n as f32) <= 0.0)
    {
        return Err("Invalid teacher transform: expected offset 4128, 69 finite means and positive finite std values".into());
    }
    Ok(())
}
