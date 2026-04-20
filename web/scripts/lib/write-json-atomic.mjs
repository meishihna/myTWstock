/**
 * Windows / Desktop / OneDrive 下覆寫既有 JSON 時，copyFile 或直接 write 皆可能 errno -4094 UNKNOWN。
 * 策略：先寫同目錄 .tmp → rename 原子替換；rename 失敗則刪 tmp 後直接 writeFile 目標；皆失敗則重試。
 */
import { rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * @param {string} filePath
 * @param {unknown} payload
 * @param {string | number | undefined} jsonSpace 傳給 JSON.stringify 的 space（undefined = 壓成一行）
 */
export async function writeJsonAtomicWithRetry(filePath, payload, jsonSpace) {
  const json =
    jsonSpace === undefined
      ? JSON.stringify(payload)
      : JSON.stringify(payload, null, jsonSpace);
  const tmp = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.${process.pid}.tmp`
  );
  let lastErr;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      await writeFile(tmp, json, "utf8");
      try {
        await rename(tmp, filePath);
        return;
      } catch {
        try {
          await unlink(tmp);
        } catch {
          /* ignore */
        }
        await writeFile(filePath, json, "utf8");
        return;
      }
    } catch (e) {
      lastErr = e;
      try {
        await unlink(tmp);
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 120 * (attempt + 1)));
    }
  }
  console.error(
    "\n無法寫入",
    filePath,
    "\n常見原因：檔案在編輯器中開著、OneDrive/防毒鎖定。請關閉該檔、暫停同步後重試；或將專案移到非同步資料夾（例如 C:\\dev）。\n"
  );
  throw lastErr;
}
