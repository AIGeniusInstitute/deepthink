plugins {
    id("com.android.application")
}

android {
    namespace = "com.aigeniusinstitute.deepthink.spike"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.aigeniusinstitute.deepthink.spike"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
        ndk {
            abiFilters += listOf("x86_64")
        }
        externalNativeBuild {
            cmake {
                // libnode.so 依赖 libc++_shared.so，必须让 APK 打包该 STL
                arguments += listOf("-DANDROID_STL=c++_shared")
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
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
