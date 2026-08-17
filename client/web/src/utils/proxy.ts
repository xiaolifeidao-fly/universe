import axios from 'axios';

/**
 * 代理请求转发服务
 * 将请求转发到真实目标服务器，隐藏真实目标地址
 */
export async function proxyRequest(targetUrl: string, data: any, headers: any = {}) {
  try {
    // 验证目标URL
    if (!targetUrl || typeof targetUrl !== 'string') {
      console.error('无效的目标URL:', targetUrl);
      return {
        success: false,
        error: '无效的目标URL',
        status: 400
      };
    }
    
    // 确保URL格式正确
    let validUrl = targetUrl;
    if (!validUrl.startsWith('http://') && !validUrl.startsWith('https://')) {
      validUrl = 'http://' + validUrl;
    }
    
    console.log(`代理请求到: ${validUrl}`);
    
    // 发送请求到真实目标服务器
    const response = await axios.post(validUrl, data, {
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    });
    
    console.log(`代理请求成功: ${validUrl}`);
    
    // 返回真实服务器的响应
    return {
      success: true,
      data: response.data,
      status: response.status
    };
  } catch (error: any) {
    console.error('代理请求失败:', error);
    
    // 返回错误信息
    return {
      success: false,
      error: error.message || '代理请求失败',
      status: error.response?.status || 500
    };
  }
} 