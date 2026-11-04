plugins {
    id("com.android.application")
    // Kotlin 支持由 AGP 9 内置（https://kotl.in/gradle/agp-built-in-kotlin）
}

android {
    namespace = "com.aigeniusinstitute.deepthink"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.aigeniusinstitute.deepthink"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "1.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // 企业侧载默认用 debug keystore 签名（可安装）；正式分发时以
            // DEEPTHINK_ANDROID_KEYSTORE 环境变量注入企业签名（见 android/README.md）。
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}
