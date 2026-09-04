/// Image service routing only; text/vision BYOK addresses are not migrated.
pub const DEFAULT_IMAGE_BASE_URL: &str = "https://cf.api.fan";

pub fn resolve_image_base_url(configured: &str) -> String {
    let base = configured.trim().trim_end_matches('/');
    match base.to_ascii_lowercase().as_str() {
        "" | "https://www.packyapi.com" | "https://packyapi.com"
        | "https://www.packyapi.com/v1" | "https://packyapi.com/v1" => {
            DEFAULT_IMAGE_BASE_URL.to_string()
        }
        _ => base.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_legacy_official_urls_use_new_image_service() {
        for base in ["", "  ", "https://www.packyapi.com", "https://packyapi.com/",
            " HTTPS://WWW.PACKYAPI.COM/// ", "https://www.packyapi.com/v1/"] {
            assert_eq!(resolve_image_base_url(base), DEFAULT_IMAGE_BASE_URL);
        }
    }

    #[test]
    fn new_and_custom_urls_are_preserved_without_trailing_slashes() {
        for (base, expected) in [
            (" https://cf.api.fan/// ", "https://cf.api.fan"),
            ("https://custom.example/proxy/", "https://custom.example/proxy"),
            ("https://www.packyapi.com.example/", "https://www.packyapi.com.example"),
            ("https://www.packyapi.com/custom/", "https://www.packyapi.com/custom"),
        ] {
            assert_eq!(resolve_image_base_url(base), expected);
        }
    }
}
