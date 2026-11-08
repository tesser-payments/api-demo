plugins {
    kotlin("jvm") version "2.1.21"
    application
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("xyz.tesser:sdk:0.0.4")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    // The SDK logs through SLF4J; without a binding SLF4J warns on stderr.
    runtimeOnly("org.slf4j:slf4j-nop:2.0.16")
    testImplementation(kotlin("test"))
}

kotlin {
    jvmToolchain(21)
}

application {
    mainClass = "xyz.tesser.apidemo.SignStepKt"
}

tasks.test {
    useJUnitPlatform()
}
