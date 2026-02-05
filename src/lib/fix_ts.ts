import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { logger } from './utils';
/**
 * 检测并修复 TS 文件头 (去除图片伪装头或修复丢失的同步字节)
 * 移植自 Python 版 analyze_ts_structure 逻辑
 */
export function checkAndRepairTsFile(filepath: string): boolean {
  try {
    // 读取文件
    const buffer = readFileSync(filepath);

    // TS 常量定义
    const TS_PACKET_SIZE = 188;
    const TS_SYNC_BYTE = 0x47;

    if (buffer.length < TS_PACKET_SIZE) return false;

    // 情况1：已经是标准 TS 头 (0x47)，无需处理
    if (buffer[0] === TS_SYNC_BYTE) {
      return false;
    }

    // ==========================================
    // 核心逻辑：扫描 0x47 同步字节
    // ==========================================

    // 搜索范围：前 50 个包的大小 (约 9KB)，足够覆盖常见的图片头
    const searchRange = Math.min(buffer.length, TS_PACKET_SIZE * 50);
    let validSyncPos = -1;

    for (let i = 0; i < searchRange; i++) {
      // 找到可能的同步字节
      if (buffer[i] === TS_SYNC_BYTE) {
        // 验证模式：检查后续 2 个包 (i + 188, i + 376) 是否也是 0x47
        let isValidPattern = true;
        let checkCount = 0;

        for (let j = 1; j <= 2; j++) {
          const nextPos = i + j * TS_PACKET_SIZE;
          if (nextPos < buffer.length) {
            checkCount++;
            if (buffer[nextPos] !== TS_SYNC_BYTE) {
              isValidPattern = false;
              break;
            }
          }
        }

        // 找到了符合 188 字节周期的位置
        if (isValidPattern && checkCount > 0) {
          validSyncPos = i;
          break;
        }
      }
    }

    // ==========================================
    // 执行修复
    // ==========================================

    if (validSyncPos > 0) {
      // 策略 A: 找到了偏移的 TS 数据（去除图片头）
      // 使用 subarray 创建视图，写入文件
      const newBuffer = buffer.subarray(validSyncPos);
      writeFileSync(filepath, newBuffer);
      return true;
    }
    // 策略 B: 没找到特征，但在开头没看到 0x47
    // 对应 Python 的 "通用头替换" -> 强制将第一个字节改为 0x47
    buffer[0] = TS_SYNC_BYTE;
    writeFileSync(filepath, buffer);
    return true;
  } catch (error) {
    logger.error('写入文件失败！', (error as Error).message);
    return false;
  }
}

/**
 * 遍历文件夹并修复
 */
function repairDirectory(dirPath: string) {
  logger.debug(`📂 开始扫描目录: ${dirPath}`);

  const files = readdirSync(dirPath);
  let totalFiles = 0;
  let repairedCount = 0;

  files.forEach(file => {
    const fullPath = join(dirPath, file);

    // 只处理 .ts 后缀的文件
    if (statSync(fullPath).isFile() && extname(file).toLowerCase() === '.ts') {
      totalFiles++;
      const wasRepaired = checkAndRepairTsFile(fullPath);

      if (wasRepaired) {
        repairedCount++;
        logger.debug(`✅ 已修复: ${file}`);
      }
    }
  });

  logger.debug('\n--- 修复报告 ---');
  logger.debug(`总计扫描 TS 文件: ${totalFiles}`);
  logger.debug(`成功执行修复数量: ${repairedCount}`);
  logger.debug(`无需修复数量: ${totalFiles - repairedCount}`);
  logger.debug('---------------');
}

function main() {
  const targetDir = 'C:\\Users\\1008\\Desktop\\ts';
  repairDirectory(targetDir);
}

main();
