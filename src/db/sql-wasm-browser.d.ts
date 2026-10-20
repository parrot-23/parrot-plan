// 为 sql.js 的浏览器构建提供类型，复用主包 @types/sql.js 的声明。
declare module 'sql.js/dist/sql-wasm-browser.js' {
    import initSqlJs from 'sql.js';
    export default initSqlJs;
}