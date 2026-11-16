use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Token {
    #[serde(rename = "move")]
    pub mv: String,
    pub start: usize,
    pub end: usize,
    pub direction_hint: Option<i32>,
}
pub fn inverse(tokens: &[Token]) -> Vec<Token> {
    tokens
        .iter()
        .rev()
        .map(|t| {
            let mut v = t.clone();
            if t.mv.contains('2') {
                v.direction_hint = t.direction_hint.map(|x| -x);
                v.mv = t.mv.trim_end_matches('\'').to_owned();
                if v.direction_hint == Some(-1) {
                    v.mv.push('\'');
                }
            } else {
                v.direction_hint = None;
                v.mv = if t.mv.ends_with('\'') {
                    t.mv[..t.mv.len() - 1].to_owned()
                } else {
                    format!("{}'", t.mv)
                };
            }
            v
        })
        .collect()
}
// Python str.isspace includes the four ASCII information separators.
fn whitespace(c: char) -> bool {
    c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c)
}
fn decimal(c: char) -> Option<usize> {
    // Python 3.11 re.\d uses Unicode 14 Nd, including non-ASCII repeats.
    const ZEROES: [u32; 66] = [
        48, 1632, 1776, 1984, 2406, 2534, 2662, 2790, 2918, 3046, 3174, 3302, 3430, 3558, 3664,
        3792, 3872, 4160, 4240, 6112, 6160, 6470, 6608, 6784, 6800, 6992, 7088, 7232, 7248, 42528,
        43216, 43264, 43472, 43504, 43600, 44016, 65296, 66720, 68912, 69734, 69872, 69942, 70096,
        70384, 70736, 70864, 71248, 71360, 71472, 71904, 72016, 72784, 73040, 73120, 92768, 92864,
        93008, 120782, 120792, 120802, 120812, 120822, 123200, 123632, 125264, 130032,
    ];
    ZEROES.iter().find_map(|z| {
        (c as u32)
            .checked_sub(*z)
            .filter(|v| *v < 10)
            .map(|v| v as usize)
    })
}
pub const MAX_INPUT_BYTES: usize = 65_536;
pub const MAX_NESTING: usize = 32;
pub fn parse(text: &str, limit: usize) -> Result<Vec<Token>, String> {
    if text.len() > MAX_INPUT_BYTES { return Err("Algorithm exceeds input byte limit".into()); }
    let chars: Vec<char> = text
        .chars()
        .map(|c| if c == '’' || c == '′' { '\'' } else { c })
        .collect();
    fn seq(c: &[char], pos: &mut usize, stops: &str, limit: usize, depth: usize) -> Result<Vec<Token>, String> {
        if depth > MAX_NESTING { return Err("Algorithm exceeds nesting limit".into()); }
        let mut out = Vec::new();
        while *pos < c.len() {
            let ch = c[*pos];
            if whitespace(ch) {
                *pos += 1;
                continue;
            }
            if stops.contains(ch) {
                break;
            }
            if ch == '(' {
                *pos += 1;
                let block = seq(c, pos, ")", limit, depth + 1)?;
                if *pos == c.len() {
                    return Err("Unclosed parenthesis".into());
                }
                *pos += 1;
                let mut count = 0usize;
                let begin = *pos;
                while *pos < c.len() && decimal(c[*pos]).is_some() {
                    count = count
                        .saturating_mul(10)
                        .saturating_add(decimal(c[*pos]).unwrap());
                    *pos += 1;
                }
                if begin == *pos {
                    count = 1;
                }
                if count > limit {
                    return Err("Repeat exceeds limit".into());
                }
                if out.len().saturating_add(block.len().saturating_mul(count)) > limit {
                    return Err("Algorithm exceeds move limit".into());
                }
                for _ in 0..count {
                    out.extend(block.clone());
                }
            } else if ch == '[' {
                *pos += 1;
                let a = seq(c, pos, ",:]", limit, depth + 1)?;
                if *pos == c.len() || !",:".contains(c[*pos]) {
                    return Err("Expected comma or colon".into());
                }
                let op = c[*pos];
                *pos += 1;
                let b = seq(c, pos, "]", limit, depth + 1)?;
                if *pos == c.len() {
                    return Err("Unclosed bracket".into());
                }
                *pos += 1;
                out.extend(a.clone());
                out.extend(b.clone());
                out.extend(inverse(&a));
                if op == ',' {
                    out.extend(inverse(&b));
                }
            } else {
                let begin = *pos;
                if !"URFDLBurfdlbMESxyz".contains(ch) {
                    return Err(format!("Invalid notation at {}", pos));
                }
                *pos += 1;
                let mut base = ch;
                if *pos < c.len() && "wW".contains(c[*pos]) {
                    if !"URFDLB".contains(base) {
                        return Err("Invalid wide notation".into());
                    }
                    base = base.to_ascii_lowercase();
                    *pos += 1;
                }
                let mut suffix = String::new();
                if *pos < c.len() && "23'".contains(c[*pos]) {
                    suffix.push(c[*pos]);
                    *pos += 1;
                    if *pos < c.len()
                        && ((suffix == "'" && "23".contains(c[*pos]))
                            || (suffix != "'" && c[*pos] == '\''))
                    {
                        suffix.push(c[*pos]);
                        *pos += 1;
                    }
                }
                if suffix.starts_with('\'') && suffix.len() == 2 {
                    suffix = format!("{}'", suffix.chars().nth(1).unwrap());
                }
                if suffix.contains('3') && !"RL".contains(base) {
                    return Err("270-degree authored strokes exist only for R/L".into());
                }
                out.push(Token {
                    mv: format!("{base}{suffix}"),
                    start: begin,
                    end: *pos,
                    direction_hint: if suffix == "2'" { Some(-1) } else { None },
                });
            }
            if out.len() > limit {
                return Err("Algorithm exceeds move limit".into());
            }
        }
        Ok(out)
    }
    seq(&chars, &mut 0, "", limit, 0)
}
pub fn equivalent(m: &str) -> String {
    if m.contains('3') {
        format!("{}{}", &m[..1], if m.ends_with('\'') { "" } else { "'" })
    } else if m.ends_with("2'") {
        m[..m.len() - 1].into()
    } else {
        m.into()
    }
}
pub fn physical(m: &str) -> Vec<String> {
    if m.contains('3') {
        vec![format!("{}{}", &m[..1], if m.ends_with('\'') { "'" } else { "" }); 3]
    } else {
        vec![equivalent(m)]
    }
}
pub fn angle(m: &str, direction: Option<i32>) -> f64 {
    let turns = if m.contains('3') {
        3
    } else if m.contains('2') {
        2
    } else {
        1
    };
    let mut sign = direction
        .filter(|v| *v != 0)
        .unwrap_or(if m.ends_with('\'') { -1 } else { 1 });
    if "LDBME".contains(m.chars().next().unwrap().to_ascii_uppercase()) {
        sign *= -1;
    }
    (-sign * turns) as f64 * std::f64::consts::PI / 2.0
}
pub fn layers(m: &str) -> (String, Vec<i32>) {
    let ch = m.chars().next().unwrap();
    if "xyz".contains(ch) {
        return (ch.to_string(), vec![-1, 0, 1]);
    }
    let (axis, layer) = match ch.to_ascii_uppercase() {
        'U' => ("y", 1),
        'D' => ("y", -1),
        'E' => ("y", 0),
        'R' => ("x", 1),
        'L' => ("x", -1),
        'M' => ("x", 0),
        'F' => ("z", 1),
        'B' => ("z", -1),
        'S' => ("z", 0),
        _ => unreachable!(),
    };
    let mut ls = vec![layer];
    if ch.is_ascii_lowercase() {
        ls.push(0);
        ls.sort();
    }
    (axis.into(), ls)
}
pub fn rot(mut v: [i32; 3], axis: usize, k: i32) -> [i32; 3] {
    for _ in 0..k.rem_euclid(4) {
        v = match axis {
            0 => [v[0], v[2], -v[1]],
            1 => [-v[2], v[1], v[0]],
            _ => [v[1], -v[0], v[2]],
        };
    }
    v
}
pub const IDENTITY: [[i32; 3]; 3] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
pub fn rotate(current: [[i32; 3]; 3], m: &str, direction: i32) -> [[i32; 3]; 3] {
    let Some(axis) = "xyz".find(m.chars().next().unwrap()) else {
        return current;
    };
    let turns = (if m.contains('2') { 2 } else { 1 })
        * (if direction != 0 {
            direction
        } else if m.ends_with('\'') {
            -1
        } else {
            1
        });
    let cols = IDENTITY.map(|v| rot(v, axis, turns));
    std::array::from_fn(|i| {
        std::array::from_fn(|j| (0..3).map(|k| cols[k][i] * current[k][j]).sum())
    })
}
pub fn state(moves: &[String]) -> Vec<([i32; 3], [i32; 3], [i32; 3], [i32; 3])> {
    let mut out = Vec::new();
    for x in -1..=1 {
        for y in -1..=1 {
            for z in -1..=1 {
                let p = [x, y, z];
                for axis in 0..3 {
                    if p[axis] != 0 {
                        let mut n = [0; 3];
                        n[axis] = p[axis];
                        out.push((p, n, p, n));
                    }
                }
            }
        }
    }
    for m in moves {
        for part in physical(m) {
            let (ax, ls) = layers(&part);
            let axis = "xyz".find(&ax).unwrap();
            let mut k = if part.contains('2') {
                2
            } else if part.ends_with('\'') {
                3
            } else {
                1
            };
            if "LDBME".contains(part.chars().next().unwrap().to_ascii_uppercase()) {
                k = -k;
            }
            for v in &mut out {
                if ls.contains(&v.0[axis]) {
                    v.0 = rot(v.0, axis, k);
                    v.1 = rot(v.1, axis, k);
                }
            }
        }
    }
    out.sort();
    out
}
pub fn fixture(text: &str) -> Result<Value, String> {
    let tokens = parse(text, 500)?;
    let moves: Vec<_> = tokens.iter().map(|t| t.mv.clone()).collect();
    Ok(
        json!({"tokens":tokens,"inverse":inverse(&tokens),"equivalent":moves.iter().map(|m|equivalent(m)).collect::<Vec<_>>(),
        "angles":tokens.iter().map(|t|angle(&t.mv,t.direction_hint)).collect::<Vec<_>>(),"state":state(&moves)}),
    )
}
pub fn normalize(payload: &Value) -> Result<Value, String> {
    let text = payload
        .get("alg")
        .and_then(Value::as_str)
        .ok_or("alg が必要です")?;
    let moves: Vec<_> = parse(text, 500)?.into_iter().map(|t| t.mv).collect();
    if moves.is_empty() {
        return Err("手順を入力してください".into());
    }
    Ok(json!({"alg":moves.join(" "),"moves":moves}))
}
