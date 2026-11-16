use serde_json::{Value, json};
use std::io::{self, BufRead, Write};
fn main() {
    let file = std::env::args()
        .nth(1)
        .expect("Usage: yubi_engine bundle.json < requests.jsonl");
    let bundle: Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    let valid = yubi_engine::catalog::Catalog::new(&bundle["catalog"])
        .and_then(|c| yubi_engine::model_contract::validate(&bundle, &c));
    if let Err(error) = valid { eprintln!("Invalid engine bundle: {error}"); std::process::exit(1); }
    let mut out = io::BufWriter::new(io::stdout().lock());
    for line in io::stdin().lock().lines() {
        let row: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let began=std::time::Instant::now();
        let result = yubi_engine::evaluate(&bundle, row["module"].as_str().unwrap(), &row["input"]);
        let compute_seconds=began.elapsed().as_secs_f64();
        writeln!(out, "{}", json!({"id":row["id"],"actual":result,"compute_seconds":compute_seconds})).unwrap();
        out.flush().unwrap();
    }
}
