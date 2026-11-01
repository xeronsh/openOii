import { create } from "zustand";
import type { Toast } from "~/types/errors";

interface ToastStore {
  toasts: Toast[];
  /** 返回新 Toast 的 id，用于之后替换 / 关闭它 */
  addToast: (toast: Omit<Toast, "id">) => string;
  removeToast: (id: string) => void;
  clearToasts: () => void;
}

const MAX_TOASTS = 5;

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],

  addToast: (toast) => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    set((state) => {
      const newToast = { ...toast, id };

      // 限制最多 5 个 Toast
      const toasts = [...state.toasts, newToast];
      if (toasts.length > MAX_TOASTS) {
        toasts.shift(); // 移除最旧的
      }

      return { toasts };
    });
    return id;
  },

  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),

  clearToasts: () => set({ toasts: [] }),
}));
