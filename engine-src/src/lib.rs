pub mod api;
pub mod candidate;
pub mod catalog;
pub mod continuation;
pub mod deterministic;
pub mod display;
pub mod features;
pub mod model;
pub mod model_contract;
pub mod normalization;
pub mod path;
pub mod scheduler;
pub mod teacher_features;
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

pub fn parameters(default: &Value, input: &Value) -> Result<Value, String> {
    let mut p = default.clone();
    if let Some(obj) = input.as_object() {
        for (key, v) in obj {
            let old = p
                .get_mut(key)
                .ok_or_else(|| format!("Unknown parameter: {key}"))?;
            if old.is_object() {
                let ob = v
                    .as_object()
                    .ok_or_else(|| format!("Unknown parameter class: {key}"))?;
                for (k, x) in ob {
                    if old.get(k).is_none() {
                        return Err(format!("Unknown parameter class: {key}"));
                    }
                    old[k] = x.clone();
                }
            } else {
                *old = v.clone();
            }
        }
    }
    for (k, v) in p.as_object().unwrap() {
        let entries: Vec<(String, &Value)> = if let Some(obj) = v.as_object() {
            obj.iter().map(|(n, x)| (format!("{k}.{n}"), x)).collect()
        } else {
            vec![(k.clone(), v)]
        };
        for (name, x) in entries {
            let n = x
                .as_f64()
                .or_else(|| x.as_bool().map(|v| if v { 1.0 } else { 0.0 }));
            if n.is_none_or(|v| !v.is_finite() || v < 0.0) {
                return Err(format!("Invalid nonnegative parameter: {name}"));
            }
        }
    }
    if p["d"]["u_flick"].as_f64() != Some(1.0) {
        return Err("d.u_flick fixes the relative-time scale at 1".into());
    }
    Ok(p)
}

#[wasm_bindgen]
pub struct Engine {
    bundle: Value,
    catalog: catalog::Catalog,
    student: model::Model,
    teacher: model::Model,
}
#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new(bundle_json: &str) -> Result<Engine, JsError> {
        let bundle: Value = serde_json::from_str(bundle_json)?;
        if bundle["schema_version"] != 1 {
            return Err(JsError::new("Unsupported bundle schema"));
        }
        let catalog = catalog::Catalog::new(&bundle["catalog"]).map_err(|e| JsError::new(&e))?;
        model_contract::validate(&bundle, &catalog).map_err(|e| JsError::new(&e))?;
        let student = model::Model::new(&bundle["student"]);
        let teacher = model::Model::new(&bundle["teacher"]);
        Ok(Self {
            bundle,
            catalog,
            student,
            teacher,
        })
    }
    pub fn normalize(&self, request_json: &str) -> Result<String, JsError> {
        let request = serde_json::from_str(request_json)?;
        let out = path::normalize(&request).map_err(|e| JsError::new(&e))?;
        Ok(serde_json::to_string(&out)?)
    }
    pub fn catalog_json(&self) -> String {
        self.bundle["catalog_response"].to_string()
    }
    pub fn action_lanes_json(&self) -> String {
        self.bundle["action_lanes_response"].to_string()
    }
    pub fn label_tasks_json(&self) -> String {
        self.bundle["label_tasks"].to_string()
    }
    pub fn search(&self, request_json: &str) -> Result<String, JsError> {
        let request = serde_json::from_str(request_json)?;
        api::search(
            &self.catalog,
            &self.bundle,
            &self.student,
            &self.teacher,
            &request,
        )
        .map(|v| v.to_string())
        .map_err(|e| JsError::new(&e))
    }
    pub fn refresh_schedule(&self, request_json: &str) -> Result<String, JsError> {
        let request = serde_json::from_str(request_json)?;
        api::refresh(&self.catalog, &self.bundle, &request)
            .map(|v| v.to_string())
            .map_err(|e| JsError::new(&e))
    }
    pub fn display_schedule(&self, request_json: &str) -> Result<String, JsError> {
        let request = serde_json::from_str(request_json)?;
        display::display(&self.catalog, &self.bundle, &self.teacher, &request)
            .map(|v| v.to_string())
            .map_err(|e| JsError::new(&e))
    }
    pub fn fixture(&self, module: &str, request_json: &str) -> Result<String, JsError> {
        let request = serde_json::from_str(request_json)?;
        Ok(evaluate(&self.bundle, module, &request).to_string())
    }
}
pub fn evaluate(bundle: &Value, module: &str, request: &Value) -> Value {
    let result=match module{
        "path"=>path::fixture(request["text"].as_str().unwrap()),
        "normalize"=>path::normalize(request),
        "params"=>parameters(&bundle["default_params"],request),
        "frames"=>Ok(json!(path::rotate(path::IDENTITY,request["move"].as_str().unwrap(),request["direction"].as_i64().unwrap() as i32))),
        "catalog"=>Ok(bundle["catalog_response"].clone()),
        "scheduler"=>catalog::Catalog::new(&bundle["catalog"]).and_then(|c|scheduler::schedule(&c,&bundle["params"],request)),
        "canonicalize"=>catalog::Catalog::new(&bundle["catalog"]).and_then(|c|Ok(json!({"route":normalization::normalize(&c,&bundle["params"],request)?,"tie_key":normalization::tie_key(&c,&bundle["params"],request)?}))),
        "student_context"=>Ok(json!(model::Model::new(&bundle["student"]).contexts(&serde_json::from_value::<Vec<usize>>(request["moves"].clone()).unwrap()))),
        "student_events"=>Ok(model::Model::new(&bundle["student"]).events_fixture(request)),
        "teacher"=>Ok(json!(model::Model::new(&bundle["teacher"]).teacher(&model::rows(&request["features"]),&model::floats(&request["costs"]),request["n"].as_u64().unwrap() as usize,&bundle["teacher"]["transform"]))),
        "candidate_search"=>catalog::Catalog::new(&bundle["catalog"]).and_then(|c|{let f=features::Features::new(&c,&bundle["student"]);candidate::solve(&c,&bundle["params"],&f,&model::Model::new(&bundle["student"]),request)}),
        "teacher_features"=>catalog::Catalog::new(&bundle["catalog"]).and_then(|c|teacher_features::extract(&c,&bundle["params"],&request["route"],&request["plan"],request.get("initial_state")).map(|x|json!(x))),
        "refresh_schedule"=>catalog::Catalog::new(&bundle["catalog"]).and_then(|c|api::refresh(&c,bundle,request)),
        "search"=>catalog::Catalog::new(&bundle["catalog"]).and_then(|c|api::search(&c,bundle,&model::Model::new(&bundle["student"]),&model::Model::new(&bundle["teacher"]),request)),
        "multipliers"=>Ok(display::multipliers(&request["positions"],&request["config"])),
        "display_schedule"=>catalog::Catalog::new(&bundle["catalog"]).and_then(|c|display::display(&c,bundle,&model::Model::new(&bundle["teacher"]),request)),
        "dot_probe"=>Ok(model::Model::new(&bundle["teacher"]).dot_probe(request)),
        "student_features"=>catalog::Catalog::new(&bundle["catalog"]).and_then(|c|features::Features::new(&c,&bundle["student"]).encode_one(&request["route"],request["alg"].as_str().unwrap())),
        "student_forward"=>Ok(model::Model::new(&bundle["student"]).forward(request)),
        _=>Err(format!("Not implemented: {module}"))
    };
    match result {
        Ok(v) => json!({"ok":v}),
        Err(e) => json!({"error":e,"error_type":"ValueError"}),
    }
}
