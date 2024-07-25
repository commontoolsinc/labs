use regex::Regex;

pub fn extract_code_blocks_from_markdown(markdown: &str, block_type: &str) -> Vec<String> {
  let pattern = format!(r"```{}\s*([\s\S]*?)\s*```", regex::escape(block_type));
  let re = Regex::new(&pattern).unwrap();
  re.captures_iter(markdown)
      .map(|cap| cap[1].to_string())
      .collect()
}