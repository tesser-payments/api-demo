package xyz.tesser.apidemo

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class TesserSignerTest {
    private val step =
        """
        {
          "id": "step-1",
          "transferId": "payment-1",
          "unsignedTransaction": "0x02f00189",
          "signWith": "0x00000000000000000000000000000000000000a1",
          "network": "POLYGON_AMOY"
        }
        """.trimIndent()

    private val wallet = """{ "name": "E2E outbound run-1", "type": "stablecoin_ethereum" }"""

    private val publicKey: String
    private val signingEnv: Map<String, String>

    init {
        val keys = throwawayApiKey()
        publicKey = keys.first
        signingEnv =
            mapOf(
                "SIGNING_PUBLIC_KEY" to keys.first,
                "SIGNING_PRIVATE_KEY" to keys.second,
                "SIGNING_ENCLAVE_ID" to "sub-org-1",
            )
    }

    @Test
    fun `sign-step stamps a sign-transaction activity for the step's transaction and wallet`() {
        val envelope = decode(runBlocking { runCommand("sign-step", step, signingEnv) })

        val body = Json.parseToJsonElement(envelope.string("body")).jsonObject
        val parameters = body.getValue("parameters").jsonObject
        assertEquals("ACTIVITY_TYPE_SIGN_TRANSACTION_V2", body.string("type"))
        assertEquals("sub-org-1", body.string("organizationId"))
        assertEquals("0x02f00189", parameters.string("unsignedTransaction"))
        assertEquals("0x00000000000000000000000000000000000000a1", parameters.string("signWith"))
        assertEquals("TRANSACTION_TYPE_ETHEREUM", parameters.string("type"))
        assertEquals(publicKey, stampPublicKey(envelope))
    }

    @Test
    fun `create-wallet stamps the wallet's creation in the enclave under its name`() {
        val envelope = decode(runBlocking { runCommand("create-wallet", wallet, signingEnv) })

        val body = Json.parseToJsonElement(envelope.string("body")).jsonObject
        assertTrue(body.string("type").startsWith("ACTIVITY_TYPE_CREATE_WALLET"), body.string("type"))
        assertEquals("sub-org-1", body.string("organizationId"))
        assertContains(envelope.string("body"), "\"E2E outbound run-1\"")
        assertEquals(publicKey, stampPublicKey(envelope))
    }

    @Test
    fun `refuses a command it doesn't know, naming the ones it does`() {
        val error =
            assertFailsWith<IllegalArgumentException> {
                runBlocking { runCommand("sign-everything", step, signingEnv) }
            }
        assertContains(error.message.orEmpty(), "sign-step")
        assertContains(error.message.orEmpty(), "create-wallet")
    }

    @Test
    fun `names the signing variable that is not set`() {
        val error =
            assertFailsWith<IllegalStateException> {
                runBlocking { runCommand("sign-step", step, signingEnv - "SIGNING_PRIVATE_KEY") }
            }
        assertContains(error.message.orEmpty(), "SIGNING_PRIVATE_KEY")
    }

    @Test
    fun `names the step field that is missing`() {
        val withoutSignWith = step.replace(""""signWith": "0x00000000000000000000000000000000000000a1",""", "")
        val error =
            assertFailsWith<IllegalArgumentException> {
                runBlocking { runCommand("sign-step", withoutSignWith, signingEnv) }
            }
        assertContains(error.message.orEmpty(), "signWith")
    }

    @Test
    fun `names the step field that is null`() {
        val withNullTransaction = step.replace(""""0x02f00189"""", "null")
        val error =
            assertFailsWith<IllegalArgumentException> {
                runBlocking { runCommand("sign-step", withNullTransaction, signingEnv) }
            }
        assertContains(error.message.orEmpty(), "unsignedTransaction")
    }
}

private fun JsonObject.string(key: String) = getValue(key).jsonPrimitive.content

private fun decode(signature: String) =
    Json.parseToJsonElement(Base64.getDecoder().decode(signature).decodeToString()).jsonObject

private fun stampPublicKey(envelope: JsonObject) =
    Json.parseToJsonElement(Base64.getUrlDecoder().decode(envelope.string("stamp")).decodeToString())
        .jsonObject
        .string("publicKey")

// A P-256 key pair in Turnkey's API key format: compressed hex public key and hex private scalar.
private fun throwawayApiKey(): Pair<String, String> {
    val generator = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }
    val pair = generator.generateKeyPair()
    val point = (pair.public as ECPublicKey).w
    val prefix = if (point.affineY.testBit(0)) "03" else "02"
    val publicKey = prefix + point.affineX.toHex32()
    val privateKey = (pair.private as ECPrivateKey).s.toHex32()
    return publicKey to privateKey
}

private fun BigInteger.toHex32() = toString(16).padStart(64, '0')
