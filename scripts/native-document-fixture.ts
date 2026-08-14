/**
 * 性能证据用的那一份稿子：它的身份。
 *
 * **接上哪个功能**：原生文档性能证据车道。它报出来的每一个数字都以
 * 「这份稿子有 100,000 块、11,953,766 字节」为前提，所以那两个数必须由
 * 一处生成、由同一处校验——两个脚本各造一份「差不多大」的语料，读数就
 * 不再可比。
 *
 * **在全局逻辑中负责什么**：那两个数与一个文件名的唯一权威。字节怎么造在
 * `run-native-document-performance.ts`——它是那个函数唯一的调用方，而验收器
 * 本身由 ScriptC 编成原生二进制，那条车道没有 `TextEncoder`。身份归这里，
 * 造法归造它的人。
 */

/** 车道测的那一份：10 万块、11,953,766 字节。 */
export const SHARED_FIXTURE_BLOCKS = 100_000;
export const SHARED_FIXTURE_BYTES = 11_953_766;
/** 语料文件名。作者在文件树里点的就是这一行。 */
export const SHARED_FIXTURE_DOCUMENT = "scale.md";
