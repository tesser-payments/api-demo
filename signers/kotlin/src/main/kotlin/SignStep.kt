package xyz.tesser.apidemo

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import xyz.tesser.sdk.LocalSigner
import xyz.tesser.sdk.SigningConfig
import xyz.tesser.sdk.StepForSigning
import kotlin.system.exitProcess

// Reads a step as JSON on stdin and prints its signature; the key comes from SIGNING_* in the environment.
fun main() {
    val stepJson = System.`in`.readBytes().decodeToString()
    try {
        println(runBlocking { signStep(stepJson, System.getenv()) })
    } catch (error: Exception) {
        System.err.println("sign-step: ${error.message}")
        exitProcess(1)
    }
}

/** Signs a payment step with the Tesser Kotlin SDK and returns the `signature` for its sign endpoint. */
suspend fun signStep(stepJson: String, env: Map<String, String>): String {
    val signer =
        LocalSigner(
            SigningConfig(
                publicKey = env.variable("SIGNING_PUBLIC_KEY"),
                privateKey = env.variable("SIGNING_PRIVATE_KEY"),
                enclaveId = env.variable("SIGNING_ENCLAVE_ID"),
            ),
        )
    val step = Json.parseToJsonElement(stepJson).jsonObject
    val toSign =
        StepForSigning(
            id = step.field("id"),
            transferId = step.field("transferId"),
            unsignedTransaction = step.field("unsignedTransaction"),
            signWith = step.field("signWith"),
            network = step.field("network"),
        )
    return signer.signStep(toSign).signature
}

private fun Map<String, String>.variable(name: String): String =
    this[name]?.takeIf { it.isNotBlank() } ?: error("$name is not set")

private fun JsonObject.field(name: String): String =
    requireNotNull(this[name]?.jsonPrimitive?.contentOrNull) { "The step has no $name" }
