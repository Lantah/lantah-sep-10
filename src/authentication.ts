import axios, { AxiosResponse } from "axios"
import { Keypair, Network, Operation, Transaction } from "stellar-sdk"
import { debug } from "./logger"

function assertChallengeOK(
  challenge: Transaction,
  serviceSigningKey: string,
  localPublicKey: string
) {
  debug("Checking challenge transaction...", {
    localPublicKey,
    serviceSigningKey
  })

  const serviceSigningKeypair = Keypair.fromPublicKey(serviceSigningKey)

  if (challenge.source !== serviceSigningKey) {
    throw Error(
      "Challenge source account does not match the remote signing account."
    )
  }
  if (String(challenge.sequence) !== "0") {
    throw Error("Challenge sequence number must be zero.")
  }

  const timeToleranceMs = 10_000

  if (!challenge.timeBounds) {
    throw Error("Challenge transaction has no time bounds set.")
  }
  if (
    Number.parseInt(challenge.timeBounds.minTime, 10) * 1000 >
    Date.now() + timeToleranceMs
  ) {
    throw Error("Challenge transaction lower time bound is in the future.")
  }
  if (
    Number.parseInt(challenge.timeBounds.maxTime, 10) * 1000 <
    Date.now() - timeToleranceMs
  ) {
    throw Error("Challenge transaction upper time bound is in the past.")
  }

  if (challenge.operations.length === 0) {
    throw Error("Challenge transaction carries no operations.")
  }

  const nonce = getNonceOperation(challenge)
  if (nonce.length !== 64) {
    throw Error("Challenge nonce must be 64 bytes long.")
  }

  if (
    !challenge.signatures.some(signature =>
      signature.hint().equals(serviceSigningKeypair.signatureHint())
    )
  ) {
    throw Error("Challenge not signed by service's signing key.")
  }

  // Everything is fine
}

function getNonceOperation(challenge: Transaction): Buffer {
  const nonceOperation = challenge.operations.filter(
    (operation): operation is Operation.ManageData =>
      operation.type === "manageData"
  )[0]

  if (!nonceOperation) {
    throw Error("Challange does not contain a manage_data operation")
  }

  return nonceOperation.value
}

export async function fetchChallenge(
  endpointURL: string,
  serviceSigningKey: string,
  localPublicKey: string
): Promise<Transaction> {
  debug(`Fetching web auth challenge from ${endpointURL}...`)
  let response: AxiosResponse<any>

  try {
    response = await axios(endpointURL, {
      params: { account: localPublicKey }
    })
  } catch (error) {
    debug(`Fetching web auth challenge from ${endpointURL} failed:`, error)
    throw Error(`Cannot fetch web auth challenge: ${error.message}`)
  }

  debug("Fetched web auth challenge:", response.data)
  const transaction = new Transaction(response.data.transaction)
  assertChallengeOK(transaction, serviceSigningKey, localPublicKey)

  return transaction
}

export async function postResponse(
  endpointURL: string,
  transaction: Transaction
): Promise<string> {
  const data = {
    transaction: transaction
      .toEnvelope()
      .toXDR()
      .toString("base64")
  }

  let response: AxiosResponse<any>
  try {
    response = await axios(endpointURL, {
      method: "POST",
      headers: {
        // SEP-10 defines a strict "application/json" content type, without charset
        "Content-Type": "application/json"
      },
      data
    })
  } catch (error) {
    debug(`Authentication at ${endpointURL} failed:`, error)
    throw Object.assign(Error(`Web authentication failed: ${error.message}`), {
      response: error.response
    })
  }

  if (!response.data || typeof response.data.token !== "string") {
    const message =
      response.data && response.data.error
        ? response.data.error
        : "No token sent."

    throw Error(`Web authentication failed: ${message}`)
  }

  return response.data.token
}

export async function authenticate(
  endpointURL: string,
  serviceSigningKey: string,
  keypair: Keypair,
  network: Network
) {
  const transaction = await fetchChallenge(
    endpointURL,
    serviceSigningKey,
    keypair.publicKey()
  )

  Network.use(network)
  transaction.sign(keypair)

  const token = await postResponse(endpointURL, transaction)
  return token
}
