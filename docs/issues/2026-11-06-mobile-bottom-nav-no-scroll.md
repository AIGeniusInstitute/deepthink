# 移动端底部一级菜单无法左右滑动，屏幕外菜单项不可达

- 日期：2026-11-06
- 影响面：移动端（手机浏览器 / PWA / Android 壳 app 内 WebView）的全局底部导航

## 1. 用户现象

移动端一级菜单位于屏幕底部（悬浮胶囊式），但**无法左右滑动**。10 个菜单项在窄屏上
超出屏幕宽度，溢出到屏幕外的菜单项（如右侧的"网盘/开放平台/设置"）**既看不见也点不到**，
等于功能入口丢失。

## 2. 问题描述

底部导航组件 `web/src/components/layout/BottomTabBar.tsx` 渲染 10 个固定宽度（52px）
的菜单项，总宽 ≈ 10×52 + 9×2(gap) + 16(padding) ≈ **554px**，超出手机视口宽度
（360–430px）。其样式（`web/src/styles/globals.css`）：

- `.floating-nav-container`：`position:fixed; left:50%; transform:translateX(-50%)`
  ——胶囊整体居中，**无 `max-width` 约束**，内容多宽容器就多宽；
- `.floating-nav`：`display:flex`，**无 `overflow-x:auto`**、无横滑能力。

结果：554px 的胶囊在 390px 屏幕上两端各溢出 ~82px，被视口裁剪且无法滚动到达。

## 3. 根因

CSS 层缺失两个约束：
1. 容器/胶囊未限制在视口内（缺 `max-width` / `width` 约束）；
2. 胶囊内部未启用横向滚动（缺 `overflow-x: auto`）。

附带陷阱（修复时必须避开）：flex 容器若用裸 `justify-content: center` 且内容溢出，
flexbox 会让**溢出侧的内容滚动不可达**（scrollLeft 无法为负）——单纯加 overflow 再配
居中会换个姿势复发本 bug，故采用 `width: max-content; max-width: 100%` 的收窄/封顶模式。

## 4. 复现路径

1. 浏览器开发者工具切到移动视口（如 iPhone 12 / 390×844），或直接用手机访问；
2. 打开任意一级页面（如 `/chat`）；
3. 观察底部胶囊导航：右侧菜单项被屏幕边缘裁掉；
4. 尝试在胶囊上左右滑动——无效（修复前）。

## 5. 诊断方法

```bash
# 查看导航项数量与样式定义
grep -c "path:" web/src/components/layout/nav-items.ts        # 10 项
grep -n "floating-nav" web/src/styles/globals.css             # 布局约束所在
# 移动视口下在控制台验证溢出：
# document.querySelector('.floating-nav').scrollWidth > document.querySelector('.floating-nav').clientWidth
```

## 6. 修复方案

```diff
# web/src/styles/globals.css
 .floating-nav-container {
   ...
+  /* 胶囊不得超出视口 */
+  width: calc(100vw - 32px);
+  max-width: 720px;
 }
 .floating-nav {
   ...
+  /* 内容不足时收窄居中；溢出时封顶并内部横滑，两端始终可达 */
+  width: max-content;
+  max-width: 100%;
+  overflow-x: auto;
+  overflow-y: hidden;
+  scroll-behavior: smooth;
+  -webkit-overflow-scrolling: touch;
+  scroll-snap-type: x proximity;
+  scrollbar-width: none;
 }
+.floating-nav::-webkit-scrollbar { display: none; }
 .floating-nav-item {
   ...
+  flex-shrink: 0;          /* 防止菜单项被 flex 压缩变形 */
+  scroll-snap-align: center;
 }
```

```diff
# web/src/components/layout/BottomTabBar.tsx
+  const navRef = useRef<HTMLElement>(null);
+  // 窄屏下把当前激活项滚进视口中央，保证定位可见（也是"可横滑"的可发现性线索）
+  useEffect(() => {
+    const el = navRef.current?.querySelector('.floating-nav-item.active');
+    el?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
+  }, [location.pathname, navItems.length]);
   ...
-  <nav className="floating-nav">
+  <nav className="floating-nav" ref={navRef}>
```

选型理由：
- `width: max-content + max-width: 100%` 比 `justify-content: safe center` 兼容面更广
  （`safe` 关键字在部分 WebView 不被支持时声明会被整体丢弃）；
- 隐藏滚动条 + `scroll-snap`：保持胶囊"液态玻璃"观感，滑动有吸附手感；
- 激活项自动居中：让用户在任意页面都能看到当前所在菜单项，同时暗示可滑动。

## 7. 处理卡住的状态

不适用（纯前端展示问题，无运行时状态残留）。

## 8. 经验沉淀 / 预防

- **固定宽度多选项的任何 flex 容器**（工具栏、tab、胶囊导航）在移动端都必须回答
  "项数多于屏幕容量时怎么办"——要么换行、要么 `overflow-x: auto` + `max-width: 100%`，
  并避免 flex 裸居中导致的溢出不可达陷阱；
- 移动端导航项尺寸建议按 44px 触摸目标 + 数量预算反推容器宽度，超预算即启用滚动；
- 评审 checklist 增补：新导航/工具栏组件需在 360px 视口下验证全部入口可达。
