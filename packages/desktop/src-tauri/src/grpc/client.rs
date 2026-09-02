use tonic::transport::Channel;

use crate::hpath::hpath_client::HpathClient;

/// Normalize a user-provided server address into a valid endpoint URI
/// (bare `host:port` gets an `http://` scheme) and validate it.
pub fn normalize_addr(addr: &str) -> Result<String, String> {
    let addr = if addr.contains("://") {
        addr.to_string()
    } else {
        format!("http://{}", addr)
    };
    tonic::transport::Endpoint::from_shared(addr.clone())
        .map(|_| addr)
        .map_err(|e| e.to_string())
}

pub async fn build_client(
    addr: String,
) -> Result<HpathClient<Channel>, String> {
    let channel = tonic::transport::Channel::from_shared(addr)
        .map_err(|e| e.to_string())?
        .connect()
        .await
        .map_err(|e| e.to_string())?;

    Ok(HpathClient::new(channel))
}
