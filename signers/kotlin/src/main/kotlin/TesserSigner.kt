package xyz.tesser.apidemo

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import xyz.tesser.sdk.CreateWalletParams
import xyz.tesser.sdk.LocalSigner
import xyz.tesser.sdk.SigningConfig
import xyz.tesser.sdk.StepForSigning
import xyz.tesser.sdk.WalletType
import kotlin.system.exitProcess

// `tesser-signer <sign-step|create-wallet>` reads the request as JSON on stdin and prints its signature.
fun main(args: Array<String>) {
    val input = System.`in`.readBytes().decodeToString()
    try {
        println(runBlocking { runCommand(args.firstOrNull(), input, System.getenv()) })
    } catch (error: Exception) {
        System.err.println("tesser-signer: ${error.message}")
        exitProcess(1)
    }
}

/** Signs `input` with the Tesser Kotlin SDK, using the key in `SIGNING_*` and the API at `TESSER_BASE_URL`. */
suspend fun runCommand(command: String?, input: String, env: Map<String, String>): String {
    val request = Json.parseToJsonElement(input).jsonObject
    return when (command) {
        "sign-step" -> signStep(localSigner(env), request)
        "create-wallet" -> signCreateWallet(localSigner(env), request)
        else -> throw IllegalArgumentException("Unknown command '$command'; use sign-step or create-wallet")
    }
}

private suspend fun signStep(signer: LocalSigner, step: JsonObject): String {
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

private suspend fun signCreateWallet(signer: LocalSigner, wallet: JsonObject): String {
    val params = CreateWalletParams(name = wallet.field("name"), type = WalletType.fromWireValue(wallet.field("type")))
    return signer.signCreateWallet(params).signature
}

private fun localSigner(env: Map<String, String>) =
    LocalSigner(
        SigningConfig(
            publicKey = env.variable("SIGNING_PUBLIC_KEY"),
            privateKey = env.variable("SIGNING_PRIVATE_KEY"),
            enclaveId = env.variable("SIGNING_ENCLAVE_ID"),
        ),
        apiBaseUrl = env.variable("TESSER_BASE_URL"),
    )

private fun Map<String, String>.variable(name: String): String =
    this[name]?.takeIf { it.isNotBlank() } ?: error("$name is not set")

private fun JsonObject.field(name: String): String =
    requireNotNull(this[name]?.jsonPrimitive?.contentOrNull) { "The request has no $name" }
