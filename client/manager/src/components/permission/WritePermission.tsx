"use client";

import { createContext, useContext } from "react";

/**
 * 「当前角色能不能写」。
 *
 * 默认 **false**：profile 还没拉回来时先当只读渲染。默认 true 的话，
 * 首帧会闪出一排可点的写按钮，只读用户点下去才被后端拒 —— 那是个能被点到的
 * 假承诺。宁可晚一帧出现，也不要先出现再消失。
 *
 * 这只是 UI 层的收敛。**真正的门在后端**：每个写接口都要过角色的资源授权，
 * 再过一道 writable。前端这一层是为了别让人点到注定失败的按钮。
 */
const WritePermissionContext = createContext(false);

export const WritePermissionProvider = WritePermissionContext.Provider;

export function useCanWrite() {
  return useContext(WritePermissionContext);
}
