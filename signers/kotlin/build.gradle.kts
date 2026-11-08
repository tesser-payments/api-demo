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

// Gradle caches a dynamic version for 24 h; check for a new release on every build.
configurations.all {
    resolutionStrategy.cacheDynamicVersionsFor(0, TimeUnit.SECONDS)
}

kotlin {
    jvmToolchain(21)
}

application {
    mainClass = "xyz.tesser.apidemo.TesserSignerKt"
}

tasks.test {
    useJUnitPlatform()
}
