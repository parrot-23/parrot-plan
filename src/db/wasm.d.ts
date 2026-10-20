// 声明 .wasm 模块导入（由 @rollup/plugin-url 在构建期内联为 base64 data URL）
declare module '*.wasm' {
    const url: string;
    export default url;
}