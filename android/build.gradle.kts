// DeepThink Android 壳 app 根构建脚本。
// 工具链：Gradle 9.8.x + AGP 9.5.x（AGP 9 起 Kotlin 支持内置，勿再 apply kotlin.android 插件，
// 见 https://kotl.in/gradle/agp-built-in-kotlin）。需 JDK 17+，开发机用 Android Studio JBR。
plugins {
    id("com.android.application") version "9.5.0" apply false
}
