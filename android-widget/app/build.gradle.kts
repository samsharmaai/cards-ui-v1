plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.cadence.widget"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.cadence.widget"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"

        val defaultWebUrl = (System.getenv("CADENCE_WEB_URL") ?: "").replace("\"", "")
        buildConfigField("String", "DEFAULT_WEB_URL", "\"$defaultWebUrl\"")
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        val ksPath = System.getenv("WIDGET_KEYSTORE_PATH")
        val ksPass = System.getenv("WIDGET_KEY_PASSWORD")
        if (!ksPath.isNullOrBlank() && !ksPass.isNullOrBlank()) {
            create("release") {
                storeFile = file(ksPath)
                storePassword = ksPass
                keyAlias = "cadence"
                keyPassword = ksPass
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.work:work-runtime-ktx:2.9.1")
}
