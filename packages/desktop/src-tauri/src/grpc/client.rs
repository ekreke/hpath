use tonic::transport::Channel;

use crate::hpath::hpath_client::HpathClient;

pub async fn build_client(
    addr: String,
) -> Result<HpathClient<Channel>, String> {
    let addr = if addr.contains("://") {
        addr
    } else {
        format!("http://{}", addr)
    };

    let channel = tonic::transport::Channel::from_shared(addr)
        .map_err(|e| e.to_string())?
        .connect()
        .await
        .map_err(|e| e.to_string())?;

    Ok(HpathClient::new(channel))
}
