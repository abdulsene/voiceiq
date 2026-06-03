/**
 * One-off provisioning script for EZ Rentals (biz_1779288494109_z4z979).
 * Runs the production provisioning module directly, bypassing HTTP auth.
 *
 * Usage on Replit production:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/provision-ez-rentals.ts
 *
 * Requires environment: BASE_URL, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
 * SUPABASE_URL, SUPABASE_SERVICE_KEY (all present in Replit production).
 *
 * Cost: ~$1/month for the provisioned DID. Idempotent — running twice
 * returns the existing number, doesn't double-buy.
 */

import {
  provisionTwilioNumberForBusiness,
  TwilioProvisioningError,
} from "../lib/twilio-provisioning";

const BUSINESS_ID = "biz_1779288494109_z4z979";
const AREA_CODE = "443"; // Baltimore, MD — EZ Rentals' market

async function main() {
  console.log(`[provision-ez-rentals] Starting provisioning for ${BUSINESS_ID} in area code ${AREA_CODE}...`);
  console.log(`[provision-ez-rentals] BASE_URL=${process.env.BASE_URL || "(not set)"}`);

  if (!process.env.BASE_URL) {
    console.error("[provision-ez-rentals] ERROR: BASE_URL env var not set. Will fail webhook precondition.");
    process.exit(1);
  }

  try {
    const result = await provisionTwilioNumberForBusiness(BUSINESS_ID, AREA_CODE);
    console.log("[provision-ez-rentals] SUCCESS:");
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    if (err instanceof TwilioProvisioningError) {
      console.error(`[provision-ez-rentals] FAILED: ${err.subcode}`);
      console.error(`[provision-ez-rentals] Message: ${err.message}`);
      process.exit(2);
    }
    console.error("[provision-ez-rentals] UNEXPECTED ERROR:");
    console.error(err);
    process.exit(3);
  }
}

main();
