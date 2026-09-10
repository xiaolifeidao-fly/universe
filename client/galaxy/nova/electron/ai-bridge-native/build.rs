fn main() {
    // 只有产出 Node 原生模块时才需要 napi 的链接参数（macOS 上的 -undefined dynamic_lookup）。
    #[cfg(feature = "node")]
    napi_build::setup();
}
