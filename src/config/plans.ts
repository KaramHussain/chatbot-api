export type PlanId = 'starter' | 'growth' | 'enterprise';

export const PLAN_CONFIG: Record<PlanId, {
  label: string;
  price: number;
  maxBots: number;
  monthlyMessageLimit: number;
  monthlyTokenBudget: number;
  aiModel: string;
  leadCaptureAllowed: boolean;
  brandingRemovable: boolean;
}> = {
  starter: {
    label: 'Free',
    price: 0,
    maxBots: 1,
    monthlyMessageLimit: 150,
    monthlyTokenBudget: 300_000,
    aiModel: 'us.amazon.nova-2-lite-v1:0',
    leadCaptureAllowed: false,
    brandingRemovable: false,
  },
  growth: {
    label: 'Growth',
    price: 39,
    maxBots: 3,
    monthlyMessageLimit: 2000,
    monthlyTokenBudget: 4_000_000,
    aiModel: 'mistral.mistral-large-3-675b-instruct',
    leadCaptureAllowed: true,
    brandingRemovable: true,
  },
  enterprise: {
    label: 'Business',
    price: 99,
    maxBots: 10,
    monthlyMessageLimit: 10000,
    monthlyTokenBudget: 20_000_000,
    aiModel: 'mistral.mistral-large-3-675b-instruct',
    leadCaptureAllowed: true,
    brandingRemovable: true,
  },
};

export function isPlanId(value: unknown): value is PlanId {
  return value === 'starter' || value === 'growth' || value === 'enterprise';
}
