import { z } from "zod";
import type { Request, Response, NextFunction } from "express";

export const businessConfigSchema = z.object({
  business_name: z.string().min(1).max(100),
  phone_number: z.string().regex(/^\+?[1-9]\d{1,14}$/).optional().or(z.literal("")),
  email: z.string().email().optional().or(z.literal("")),
  industry: z.string().max(50).optional(),
  timezone: z.string().max(50).optional(),
  owner_name: z.string().max(100).optional(),
  website: z.string().url().optional().or(z.literal("")),
  business_hours: z.string().max(200).optional(),
  services: z.string().max(2000).optional(),
  address: z.string().max(500).optional(),
});

export const onboardSchema = z.object({
  business_name: z.string().min(1).max(100),
  industry: z.string().min(1).max(50),
  email: z.string().email(),
  phone_number: z.string().regex(/^\+?[1-9]\d{1,14}$/).optional().or(z.literal("")),
  owner_name: z.string().max(100).optional(),
  website: z.string().url().optional().or(z.literal("")),
  business_hours: z.string().max(200).optional(),
  services: z.string().max(2000).optional(),
  address: z.string().max(500).optional(),
  timezone: z.string().max(50).optional(),
});

export const authLoginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(6).max(128),
});

export const authSignupSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  business_name: z.string().min(1).max(100).optional(),
  full_name: z.string().max(100).optional(),
  phone_number: z.string().max(20).optional(),
  industry: z.string().max(50).optional(),
  timezone: z.string().max(50).optional(),
  sms_opt_in: z.boolean().optional(),
  // Twilio 10DLC: separate transactional vs marketing consent flags.
  sms_consent_transactional: z.boolean().optional(),
  sms_consent_marketing: z.boolean().optional(),
  // Sprint 1 BUG-17 sub-step 3b: optional plan selection forwarded by
  // PricingPage when an unauthenticated visitor clicks a tier. Constrained
  // to the 6 self-serve plans + monthly|annual; missing values default to
  // essential/monthly inside the handler.
  plan_id: z.enum(["essential", "starter", "professional", "growth", "business", "enterprise"]).optional(),
  billing_cycle: z.enum(["monthly", "annual"]).optional(),
});

export const contactSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email().max(255),
  message: z.string().min(1).max(5000),
  phone: z.string().max(20).optional(),
  company: z.string().max(100).optional(),
});

export const smsSchema = z.object({
  to: z.string().regex(/^\+?[1-9]\d{1,14}$/),
  body: z.string().min(1).max(1600),
  businessId: z.string().max(100).optional(),
});

export function validate(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const errors = result.error.issues.map((i) => ({
        field: i.path.join("."),
        message: i.message,
      }));
      res.status(400).json({ error: "Validation failed", details: errors });
      return;
    }
    req.body = result.data;
    next();
  };
}
