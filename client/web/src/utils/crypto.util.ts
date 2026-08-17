/**
 * 加密工具类 - 前端版本
 */
export class CryptoUtil {
  /**
   * 加密数据 - 简单混淆
   * @param plaintext 明文
   * @returns 混淆后的Base64编码字符串
   */
  public static encrypt(plaintext: string): string {
    try {
      // 先进行Base64编码
      const base64 = btoa(plaintext);
      
      // 对Base64编码后的字符串进行简单混淆
      return this.simpleObfuscate(base64);
    } catch (error) {
      console.error('加密失败:', error);
      throw error;
    }
  }
  
  /**
   * 简单混淆算法 - 只处理前10个字符
   * 1. 在第3位和第7位插入随机字符
   * 2. 第1位和第5位互换
   * 3. 第2位和第8位互换
   */
  private static simpleObfuscate(base64: string): string {
    if (base64.length < 8) {
      // 如果字符串太短，添加一些填充
      base64 = base64.padEnd(8, '=');
    }
    
    // 生成两个随机字符
    const randomChar1 = this.getRandomChar();
    const randomChar2 = this.getRandomChar();
    
    // 将字符串转为数组以便操作
    const chars = base64.split('');
    
    // 在第3位和第7位插入随机字符
    chars.splice(2, 0, randomChar1);
    chars.splice(7, 0, randomChar2);
    
    // 第1位和第5位互换
    [chars[0], chars[5]] = [chars[5], chars[0]];
    
    // 第2位和第8位互换
    [chars[1], chars[9]] = [chars[9], chars[1]];
    
    // 添加一个标记字符，表示这是混淆过的数据
    chars.unshift('$');
    
    return chars.join('');
  }
  
  /**
   * 生成随机字符
   */
  private static getRandomChar(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    return chars.charAt(Math.floor(Math.random() * chars.length));
  }
} 