import { DesktopOnboardingScreen } from './types';

interface ResolveAdjacentScreenInput {
  current: DesktopOnboardingScreen;
  isMac: boolean;
}

interface ResolveNextScreenInput extends ResolveAdjacentScreenInput {
  everCompleted: boolean;
  isAuthenticated: boolean;
  isPortableMode?: boolean;
}

const getDesktopOnboardingFlow = (isMac: boolean, isPortableMode = false) =>
  isMac
    ? isPortableMode
      ? [
          DesktopOnboardingScreen.Welcome,
          DesktopOnboardingScreen.Permissions,
          DesktopOnboardingScreen.DataMode,
        ]
      : [
          DesktopOnboardingScreen.Welcome,
          DesktopOnboardingScreen.Login,
          DesktopOnboardingScreen.Permissions,
          DesktopOnboardingScreen.DataMode,
        ]
    : isPortableMode
      ? [DesktopOnboardingScreen.Welcome, DesktopOnboardingScreen.DataMode]
      : [
          DesktopOnboardingScreen.Welcome,
          DesktopOnboardingScreen.Login,
          DesktopOnboardingScreen.DataMode,
        ];

export const resolveNextScreen = ({
  current,
  everCompleted,
  isAuthenticated,
  isMac,
  isPortableMode = false,
}: ResolveNextScreenInput): DesktopOnboardingScreen | null => {
  if (current === DesktopOnboardingScreen.Login && !isAuthenticated && !isPortableMode) {
    return DesktopOnboardingScreen.Login;
  }
  if (everCompleted && current === DesktopOnboardingScreen.Login) return null;

  const flow = getDesktopOnboardingFlow(isMac, isPortableMode);
  const index = flow.indexOf(current);
  const next = flow[index + 1] ?? null;

  return next ?? (isAuthenticated || isPortableMode ? null : DesktopOnboardingScreen.Login);
};

export const resolvePreviousScreen = ({
  current,
  isMac,
}: ResolveAdjacentScreenInput): DesktopOnboardingScreen => {
  const flow = getDesktopOnboardingFlow(isMac);
  const index = flow.indexOf(current);
  return flow[Math.max(0, index - 1)] ?? DesktopOnboardingScreen.Login;
};
