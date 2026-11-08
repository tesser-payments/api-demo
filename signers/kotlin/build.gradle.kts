import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.util.concurrent.TimeUnit

plugins {
    kotlin("jvm") version "2.1.21"
    application
}

repositories {
    mavenCentral()
}

dependencies {
    // The newest published SDK, so the E2E catches a release that breaks signing.
    implementation("xyz.tesser:sdk:latest.release")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    // The SDK logs through SLF4J; without a binding SLF4J warns on stderr.
    runtimeOnly("org.slf4j:slf4j-nop:2.0.16")
    testImplementation(kotlin("test"))
}

configurations.all {
    resolutionStrategy {
        // CI must see a release the moment it is published; local builds keep Gradle's 24 h cache.
        if (System.getenv("CI") != null) cacheDynamicVersionsFor(0, TimeUnit.SECONDS)
        // Maven counts every non-SNAPSHOT version as a release; customers don't run pre-releases.
        componentSelection {
            all {
                if (candidate.group == "xyz.tesser" && candidate.version.contains('-')) reject("pre-release")
            }
        }
    }
}

// Builds with whichever JDK runs Gradle; the output runs on Java 17+, like the SDK.
java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
    }
}

application {
    mainClass = "xyz.tesser.apidemo.TesserSignerKt"
}

tasks.test {
    useJUnitPlatform()
}
