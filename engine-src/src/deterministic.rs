//! Cache hashing must not request OS entropy (native or WASM).
//! Iteration of these maps/sets never determines candidate ordering.
use std::hash::{BuildHasherDefault, DefaultHasher};
pub type HashMap<K, V> = std::collections::HashMap<K, V, BuildHasherDefault<DefaultHasher>>;
pub type HashSet<K> = std::collections::HashSet<K, BuildHasherDefault<DefaultHasher>>;

/// Python JSON-value equality: 1 == 1.0 == True. JavaScript JSON.stringify
/// drops the .0, so serde_json's representation-sensitive PartialEq is wrong
/// for checking continuation parameters across the JS/WASM boundary.
pub fn python_equal(a:&serde_json::Value,b:&serde_json::Value)->bool{
    use serde_json::Value;
    let number=|v:&Value|v.as_f64().or_else(||v.as_bool().map(|x|if x{1.0}else{0.0}));
    if let(Some(a),Some(b))=(number(a),number(b)){return a==b;}
    match(a,b){
        (Value::Array(a),Value::Array(b))=>a.len()==b.len()&&a.iter().zip(b).all(|(a,b)|python_equal(a,b)),
        (Value::Object(a),Value::Object(b))=>a.len()==b.len()&&a.iter().all(|(k,a)|b.get(k).is_some_and(|b|python_equal(a,b))),
        _=>a==b
    }
}
