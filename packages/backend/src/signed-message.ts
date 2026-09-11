import { isAddressEqual, recoverMessageAddress, type Address, type Hex } from 'viem';

import type { SiweLogin } from './siwe.js';

export class JoinAuthenticationError extends Error {}

export async function verifySignedMessage(
  login: SiweLogin,
  nonce: string,
  message: string,
  signature: Hex,
  address: Address,
): Promise<void> {
  if (!login.nonceAvailable(nonce)) throw new JoinAuthenticationError('Unknown or already used nonce');
  const recovered = await recoverMessageAddress({ message, signature }).catch(() => undefined);
  if (recovered === undefined || !isAddressEqual(recovered, address)) {
    throw new JoinAuthenticationError('Signature does not match the claimed address');
  }
}
