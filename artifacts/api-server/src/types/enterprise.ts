/**
 * Enterprise multi-tenant types: business hierarchy (franchise → region →
 * district → store), branding, security policy, location structures, and
 * supporting value types used by the /api/enterprise routes.
 */

export type EnterpriseTier = "essential" | "professional" | "enterprise" | "government";
export type IsolationModel = "shared" | "dedicated";
export type SLALevel = "99.9%" | "99.99%";

export interface PasswordPolicy {
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumbers: boolean;
  requireSpecialChars: boolean;
  maxAge: number; // days
}

export interface SecurityPolicy {
  mfaRequired: boolean;
  passwordPolicy: PasswordPolicy;
  sessionTimeout: number;
  ipWhitelisting: boolean;
  allowedIPs?: string[];
  dataRetention: number; // days
  encryptionRequired: boolean;
}

export interface BrandingConfig {
  logo: string;
  primaryColor: string;
  secondaryColor: string;
  fontFamily: string;
  customCSS?: string;
  whiteLabel: boolean;
}

export interface Integration {
  id: string;
  name: string;
  type: "crm" | "pos" | "calendar" | "helpdesk" | "analytics";
  provider: string;
  enabled: boolean;
  config: Record<string, unknown>;
  lastSync?: string;
}

export interface EnterpriseBusiness {
  id: string;
  name: string;
  tier: EnterpriseTier;
  isolation: IsolationModel;
  customDomain?: string;
  parentBusinessId?: string;
  childBusinesses?: string[];
  brandingConfig: BrandingConfig;
  securityPolicy: SecurityPolicy;
  integrations: Integration[];
  slaLevel: SLALevel;
  dedicatedInfrastructure: boolean;
}

export interface Address {
  street: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
}

export interface PhoneNumber {
  number: string;
  type: "main" | "fax" | "emergency";
  forwardTo?: string;
}

export interface DayHours {
  open: string;  // "09:00"
  close: string; // "17:00"
  closed: boolean;
}

export interface Holiday {
  date: string; // ISO yyyy-mm-dd
  name: string;
  closed: boolean;
  customHours?: DayHours;
}

export interface OperatingHours {
  monday: DayHours;
  tuesday: DayHours;
  wednesday: DayHours;
  thursday: DayHours;
  friday: DayHours;
  saturday: DayHours;
  sunday: DayHours;
  holidays: Holiday[];
}

export interface StaffMember {
  id: string;
  name: string;
  role: string;
  email: string;
  phone?: string;
  department?: string;
  permissions: string[];
}

export interface Promotion {
  id: string;
  name: string;
  description: string;
  startDate: string;
  endDate: string;
  locations: string[];
  active: boolean;
}

export interface LocationCustomizations {
  menuItems?: string[];
  pricing?: Record<string, number>;
  promotions?: Promotion[];
  staffDirectory?: StaffMember[];
  localKnowledge?: string;
  aiPersonality?: string;
}

export type LocationLevel = "corporate" | "region" | "district" | "store";

export interface LocationHierarchy {
  id: string;
  businessId: string;
  parentId?: string;
  level: LocationLevel;
  locationCode: string;
  name: string;
  address: Address;
  phoneNumbers: PhoneNumber[];
  operatingHours: OperatingHours;
  customizations: LocationCustomizations;
  status: "active" | "inactive" | "pending";
  managers: StaffMember[];
}

export interface BulkLocationInput
  extends Partial<Omit<LocationHierarchy, "id" | "businessId" | "status">> {
  locationCode: string;
  name: string;
}

export interface BulkUserInput {
  email: string;
  name?: string;
  role?: "owner" | "admin" | "manager" | "user" | "readonly";
  phone?: string;
  department?: string;
}

// ---- CRM integration types ----

export type CRMProvider =
  | "salesforce"
  | "hubspot"
  | "dynamics"
  | "servicenow"
  | "pipedrive";

export interface CRMCredentials {
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  instanceUrl?: string;
  username?: string;
  clientId?: string;
  clientSecret?: string;
  encryptedData?: string;
}

export interface CRMFieldMapping {
  neverrField: string;
  crmField: string;
  syncDirection: "neverr_to_crm" | "crm_to_neverr" | "bidirectional";
  required: boolean;
  defaultValue?: string;
}

export interface AutomationCondition {
  field: string;
  operator: "equals" | "contains" | "greater_than" | "less_than" | "not_empty";
  value: string;
}

export type AutomationTrigger =
  | "call_completed"
  | "appointment_booked"
  | "lead_qualified"
  | "customer_satisfied"
  | "missed_call";

export type CRMAction =
  | "create_lead"
  | "update_contact"
  | "create_task"
  | "create_opportunity"
  | "add_note";

export interface AutomationRule {
  id: string;
  name: string;
  trigger: AutomationTrigger;
  conditions: AutomationCondition[];
  crmAction: CRMAction;
  fieldMappings: Record<string, string>;
  enabled: boolean;
}

export interface CRMIntegration {
  id: string;
  businessId: string;
  provider: CRMProvider;
  credentials: CRMCredentials;
  syncEnabled: boolean;
  syncFields: CRMFieldMapping[];
  automationRules: AutomationRule[];
  lastSync?: string;
  status: "active" | "inactive" | "error";
  errorMessage?: string;
}

// ---- Webhook types ----

export interface RetryPolicy {
  maxRetries: number;
  backoffStrategy: "linear" | "exponential";
  retryDelays: number[];
  deadLetterQueue: boolean;
}

// ---- Enterprise analytics types ----

export interface AnalyticsTimeRange {
  start: string;
  end: string;
  period: "hour" | "day" | "week" | "month" | "quarter" | "year";
  timezone: string;
}

export interface AnalyticsMetrics {
  totalCalls: number;
  answeredCalls: number;
  missedCalls: number;
  averageCallDuration: number;
  appointmentsBooked: number;
  leadsGenerated: number;
  customerSatisfactionScore: number;
  revenueAttribution: number;
  costPerCall: number;
  conversionRate: number;
  firstCallResolution: number;
  peakCallVolume: number;
  averageWaitTime: number;
}

export interface AnalyticsBreakdowns {
  byLocation?: Record<string, AnalyticsMetrics>;
  byAgent?: Record<string, AnalyticsMetrics>;
  byTimeOfDay?: Record<string, AnalyticsMetrics>;
  byDayOfWeek?: Record<string, AnalyticsMetrics>;
  byCallType?: Record<string, AnalyticsMetrics>;
  byLanguage?: Record<string, AnalyticsMetrics>;
}

export interface AnalyticsComparisons {
  previousPeriod: AnalyticsMetrics;
  yearOverYear?: AnalyticsMetrics;
  industryBenchmark?: AnalyticsMetrics;
}

export interface AnalyticsAlert {
  id: string;
  type: "spike" | "drop" | "threshold" | "anomaly";
  metric: string;
  severity: "low" | "medium" | "high" | "critical";
  message: string;
  timestamp: string;
  acknowledged: boolean;
}

export interface EnterpriseAnalytics {
  businessId: string;
  timeRange: AnalyticsTimeRange;
  metrics: AnalyticsMetrics;
  breakdowns: AnalyticsBreakdowns;
  comparisons: AnalyticsComparisons;
  alerts: AnalyticsAlert[];
}

// ---- Custom reporting types ----

export interface ReportField {
  name: string;
  alias?: string;
  aggregation?: "sum" | "avg" | "count" | "min" | "max";
}

export interface QueryFilter {
  field: string;
  operator:
    | "equals"
    | "not_equals"
    | "contains"
    | "greater_than"
    | "less_than"
    | "between"
    | "in";
  value: unknown;
  logicalOperator?: "AND" | "OR";
}

export interface ReportQuery {
  tables: string[];
  fields: ReportField[];
  filters: QueryFilter[];
  groupBy: string[];
  orderBy: { field: string; direction: "ASC" | "DESC" }[];
  limit?: number;
  dateRange: AnalyticsTimeRange;
}

export interface ReportVisualization {
  id: string;
  type:
    | "line_chart"
    | "bar_chart"
    | "pie_chart"
    | "table"
    | "kpi_card"
    | "heatmap"
    | "funnel"
    | "gauge";
  title: string;
  subtitle?: string;
  dataBinding: {
    xAxis?: string;
    yAxis?: string[];
    groupBy?: string;
    valueField?: string;
  };
  position: { row: number; col: number; width: number; height: number };
}

export interface ReportSchedule {
  frequency: "daily" | "weekly" | "monthly" | "quarterly";
  time: string;
  timezone: string;
  daysOfWeek?: number[];
  dayOfMonth?: number;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
}

export interface CustomReport {
  id: string;
  name: string;
  description?: string;
  businessId: string;
  createdBy: string;
  createdAt: string;
  lastModified: string;
  reportType: "dashboard" | "scheduled" | "api" | "compliance";
  dataQuery: ReportQuery;
  visualizations: ReportVisualization[];
  schedule?: ReportSchedule;
  recipients?: string[];
  format: "pdf" | "csv" | "xlsx" | "json" | "html";
}

// ---- Compliance reporting types ----

export interface ComplianceFinding {
  id: string;
  category: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  title: string;
  description: string;
  evidence: string[];
  affectedSystems: string[];
  remediationRequired: boolean;
}

export interface ComplianceRecommendation {
  id: string;
  category: string;
  priority: "low" | "medium" | "high";
  title: string;
  description: string;
  estimatedEffort: string;
  deadline?: string;
}

export interface ComplianceReport {
  id: string;
  businessId: string;
  reportType: "soc2" | "hipaa" | "pci_dss" | "gdpr" | "government_audit";
  period: AnalyticsTimeRange;
  generatedAt: string;
  generatedBy: string;
  status: "generating" | "completed" | "failed";
  findings: ComplianceFinding[];
  recommendations: ComplianceRecommendation[];
}

export interface EnterpriseWebhook {
  id: string;
  businessId: string;
  name: string;
  url: string;
  events: string[];
  authentication: "none" | "bearer" | "hmac" | "oauth";
  authConfig: Record<string, string>;
  retryPolicy: RetryPolicy;
  enabled: boolean;
  lastDelivery?: string;
  failureCount: number;
  headers: Record<string, string>;
}

// ============================================================================
// Government / Regulated-industry compliance
// ============================================================================

export interface GovernmentCompliance {
  agencyType: "federal" | "state" | "local" | "military";
  clearanceLevel?: "public" | "sensitive" | "confidential" | "secret" | "top_secret";
  dataResidency: "us_only" | "us_canada" | "fedramp_moderate" | "fedramp_high";
  auditRequirements: AuditRequirement[];
  accessControls: GovernmentAccessControl[];
  dataClassification: DataClassification;
  retentionPolicy: RetentionPolicy;
}

export interface AuditRequirement {
  standard: "FISMA" | "NIST" | "FEDRAMP" | "CJIS" | "IRS1075";
  controls: string[];
  frequency: "continuous" | "annual" | "biannual";
  lastAudit?: string;
  nextAudit?: string;
  status: "compliant" | "non_compliant" | "in_progress";
}

export interface GovernmentAccessControl {
  userId: string;
  clearanceLevel: string;
  accessJustification: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  accessScope: string[];
  monitoringLevel: "standard" | "enhanced" | "continuous";
}

export interface DataClassification {
  level: "public" | "internal" | "confidential" | "restricted";
  categories: string[];
  handlingInstructions: string;
  disseminationControls: string[];
  markingRequirements: string;
}

export interface RetentionPolicy {
  defaultRetentionDays: number;
  legalHoldCategories: string[];
  automaticDeletion: boolean;
  archiveBeforeDelete: boolean;
  approvalRequired: boolean;
  exceptions: RetentionException[];
}

export interface RetentionException {
  category: string;
  retentionDays: number;
  justification: string;
  approvedBy: string;
}

export interface GovernmentAccessRequest {
  id: string;
  userId: string;
  businessId: string;
  resourceId: string;
  justification: string;
  clearanceLevel: string;
  requestedAt: string;
  status: "pending_approval" | "approved" | "denied" | "expired";
  duration: number;
  expiresAt: string;
  reviewers: string[];
}
