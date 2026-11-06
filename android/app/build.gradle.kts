import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}
val releaseVersion = Properties().apply {
    rootProject.file("version.properties").inputStream().use { load(it) }
}
val buildNumber = (System.getenv("ANDROID_BUILD_NUMBER") ?: releaseVersion.getProperty("versionCode")).toInt()
require(buildNumber in 1..2_100_000_000) { "Android versionCode is out of range" }
val uploadStore = System.getenv("ANDROID_UPLOAD_KEYSTORE_PATH")
android {
    namespace = "online.proappstore.companion"
    compileSdk = 36
    defaultConfig {
        applicationId = "online.proappstore.companion"
        minSdk = 29
        targetSdk = 36
        versionCode = buildNumber
        versionName = releaseVersion.getProperty("versionName")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    signingConfigs {
        if (!uploadStore.isNullOrBlank()) create("upload") {
            storeFile = file(uploadStore)
            storePassword = System.getenv("ANDROID_UPLOAD_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("ANDROID_UPLOAD_KEY_ALIAS")
            keyPassword = System.getenv("ANDROID_UPLOAD_KEY_PASSWORD")
        }
    }
    buildTypes {
        release {
            if (!uploadStore.isNullOrBlank()) signingConfig = signingConfigs.getByName("upload")
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
}
// A release task must never quietly produce an unsigned artifact or use a debug key.
gradle.taskGraph.whenReady {
    if (allTasks.any { it.project == project && it.name in listOf("assembleRelease", "bundleRelease", "packageRelease", "signReleaseBundle") }) {
        require(!uploadStore.isNullOrBlank() && listOf("ANDROID_UPLOAD_KEYSTORE_PASSWORD", "ANDROID_UPLOAD_KEY_ALIAS", "ANDROID_UPLOAD_KEY_PASSWORD").all { !System.getenv(it).isNullOrBlank() }) {
            "Release signing is required. Use scripts/build-android-release.sh with PAS upload credentials."
        }
    }
}
dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2025.10.00")
    implementation(composeBom)
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.4")
    implementation("androidx.work:work-runtime-ktx:2.10.5")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation(composeBom)
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
