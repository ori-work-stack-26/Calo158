import { SplashScreen, Stack } from "expo-router";
import { Provider } from "react-redux";
import { PersistGate } from "redux-persist/integration/react";
import { store, persistor } from "@/src/store";
import { StatusBar } from "expo-status-bar";
import {
  Text,
  View,
  ActivityIndicator,
  StyleSheet,
  Platform,
} from "react-native";
import { QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ThemeProvider } from "@/src/context/ThemeContext";
import { useRouter, useSegments } from "expo-router";
import { useEffect, useMemo, useRef } from "react";
import { queryClient } from "@/src/providers/QueryProvider";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import "@/src/i18n"; // Initialize i18n
import { LanguageProvider } from "@/src/i18n/context/LanguageContext";
import { useFonts } from "expo-font";
import "react-native-reanimated";
import { I18nextProvider } from "react-i18next";
import i18n from "@/src/i18n";
import LanguageToolbar from "@/components/ToolBar";
import { NotificationService } from "@/src/services/notifications";
import React from "react";
import FloatingChatButton from "@/components/FloatingChatButton";
import { I18nManager } from "react-native";
import { useOptimizedAuthSelector } from "@/hooks/useOptimizedSelector";
import { ErrorHandler } from "@/src/utils/errorHandler";
import { useTranslation } from "react-i18next";

// Enable RTL support globally
if (Platform.OS !== "web") {
  I18nManager.allowRTL(true);
}

SplashScreen.preventAutoHideAsync();

// Update the navigation state logic with proper memoization
function useNavigationState(
  user: any,
  isAuthenticated: boolean,
  segments: string[]
) {
  return useMemo(() => {
    const currentPath = segments?.[0] || "";
    const inAuthGroup = currentPath === "(auth)";
    const inTabsGroup = currentPath === "(tabs)";
    const onPaymentPlan = currentPath === "payment-plan";
    const onPayment = currentPath === "payment";
    const onQuestionnaire = inTabsGroup && segments?.[1] === "questionnaire";
    const onEmailVerification =
      inAuthGroup && segments?.[1] === "email-verification";

    const currentRoute = "/" + segments.join("/");

    let targetRoute: string | null = null;

    if (!isAuthenticated || !user) {
      if (!inAuthGroup) {
        targetRoute = "/(auth)/signin";
      }
    } else if (user && !user.email_verified && !onEmailVerification) {
      targetRoute = "/(auth)/email-verification";
    } else if (
      user?.subscription_type === "FREE" &&
      !onPaymentPlan &&
      !onPayment
    ) {
      targetRoute = "/payment-plan";
    } else if (!user?.is_questionnaire_completed && !onQuestionnaire) {
      targetRoute = "/(tabs)/questionnaire";
    } else if (
      !inTabsGroup &&
      isAuthenticated &&
      user?.email_verified &&
      user?.subscription_type &&
      !onPayment &&
      !onPaymentPlan &&
      !onQuestionnaire
    ) {
      targetRoute = "/(tabs)";
    }

    return {
      targetRoute,
      currentRoute,
      shouldNavigate: targetRoute !== null && targetRoute !== currentRoute,
    };
  }, [
    user?.email_verified,
    user?.subscription_type,
    user?.is_questionnaire_completed,
    user?.email,
    isAuthenticated,
    segments?.join("/") || "",
  ]);
}

function useNavigationManager(
  targetRoute: string | null,
  currentRoute: string,
  shouldNavigate: boolean,
  loaded: boolean
) {
  const router = useRouter();
  const lastNavigationRef = useRef<string | null>(null);
  const isNavigatingRef = useRef(false);
  const navigationTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const segments = useSegments();

  useEffect(() => {
    if (!loaded || !shouldNavigate || !targetRoute || isNavigatingRef.current) {
      return;
    }

    const currentPath = segments?.[0] || "";
    const currentFullPath = "/" + segments.join("/");

    if (
      currentPath === "payment" ||
      currentPath === "payment-plan" ||
      currentPath === "questionnaire" ||
      currentFullPath.includes("questionnaire") ||
      currentPath === "menu"
    ) {
      return;
    }

    if (lastNavigationRef.current === targetRoute) {
      return;
    }

    isNavigatingRef.current = true;
    lastNavigationRef.current = targetRoute;

    // Debounce navigation to prevent rapid successive navigations
    if (navigationTimeoutRef.current) {
      clearTimeout(navigationTimeoutRef.current);
    }

    navigationTimeoutRef.current = setTimeout(() => {
      router.replace(targetRoute as any);
      
      const resetTimeout = setTimeout(() => {
        isNavigatingRef.current = false;
      }, 200);

      return () => {
        clearTimeout(resetTimeout);
      };
    }, 100);

    return () => {
      if (navigationTimeoutRef.current) {
        clearTimeout(navigationTimeoutRef.current);
      }
    };
  }, [loaded, shouldNavigate, targetRoute, router, segments]);
}

const LoadingScreen = React.memo(() => (
  <View style={styles.loadingContainer}>
    <ActivityIndicator size="large" color="#10b981" />
    <Text style={styles.loadingText}>Loading...</Text>
  </View>
));

const StackScreens = React.memo(() => (
  <Stack screenOptions={{ headerShown: false }}>
    <Stack.Screen name="(auth)" />
    <Stack.Screen name="(tabs)" />
    <Stack.Screen name="payment-plan" />
    <Stack.Screen name="payment" />
    <Stack.Screen name="questionnaire" />
    <Stack.Screen name="menu/[id]" />
    <Stack.Screen name="+not-found" />
  </Stack>
));

function useHelpContent(): { title: string; description: string } | undefined {
  const segments = useSegments();
  const { t } = useTranslation();

  return useMemo(() => {
    const route = "/" + segments.join("/");

    const helpContentMap: Record<
      string,
      { title: string; description: string }
    > = {
      "/questionnaire": {
        title: t("questionnaire.title"),
        description: t("tabs.questionnaire_description"),
      },
      "/(tabs)": {
        title: t("tabs.home"),
        description: t("tabs.home_description"),
      },
      "/(tabs)/index": {
        title: t("tabs.home"),
        description: t("tabs.home_description"),
      },
      "/(tabs)/calendar": {
        title: t("tabs.calendar"),
        description: t("tabs.calendar_description"),
      },
      "/(tabs)/statistics": {
        title: t("tabs.statistics"),
        description: t("tabs.statistics_description"),
      },
      "/(tabs)/camera": {
        title: t("tabs.camera"),
        description: t("tabs.camera_description"),
      },
      "/(tabs)/food-scanner": {
        title: t("tabs.food_scanner"),
        description: t("tabs.food_scanner_description"),
      },
      "/(tabs)/ai-chat": {
        title: t("tabs.ai_chat"),
        description: t("tabs.ai_chat_description"),
      },
      "/(tabs)/recommended-menus": {
        title: t("tabs.recommended_menus"),
        description: t("tabs.recommended_menus_description"),
      },
      "/(tabs)/history": {
        title: t("tabs.history"),
        description: t("tabs.history_description"),
      },
      "/(tabs)/profile": {
        title: t("tabs.profile"),
        description: t("tabs.profile_description"),
      },
      "/(tabs)/devices": {
        title: t("tabs.devices"),
        description: t("tabs.devices_description"),
      },
      "/(tabs)/questionnaire": {
        title: t("questionnaire.title"),
        description: t("tabs.questionnaire_description"),
      },
    };

    return (
      helpContentMap[route] || {
        title: t("common.help"),
        description: t("tabs.home_description"),
      }
    );
  }, [segments, t]);
}

const AppContent = React.memo(() => {
  const authState = useOptimizedAuthSelector();
  const { isAuthenticated = false, user = null } = authState || {};

  const [loaded] = useFonts({
    SpaceMono: require("../assets/fonts/SpaceMono-Regular.ttf"),
  });

  const segments = useSegments() as string[];
  const navigationState = useNavigationState(user, isAuthenticated, segments);

  useNavigationManager(
    navigationState.targetRoute,
    navigationState.currentRoute,
    navigationState.shouldNavigate,
    loaded
  );

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync();
      
      // Initialize notifications with timeout
      const initNotifications = async () => {
        try {
          await Promise.race([
            NotificationService.requestPermissions(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("Notification timeout")), 5000)
            ),
          ]);
        } catch (error) {
          console.warn("Failed to request notification permissions:", error);
        }
      };
      
      initNotifications();
    }
  }, [loaded]);

  if (!loaded) {
    return null;
  }

  return <StackScreens />;
});

const MainApp = React.memo(() => {
  const helpContent = useHelpContent();
  const authState = useOptimizedAuthSelector();
  const { isAuthenticated = false } = authState || {};

  return (
    <View style={styles.container}>
      <LanguageToolbar helpContent={helpContent} />
      <AppContent />
      {isAuthenticated && <FloatingChatButton />}
    </View>
  );
});

export default function RootLayout() {
  return (
    <I18nextProvider i18n={i18n}>
      <GestureHandlerRootView style={styles.root}>
        <SafeAreaProvider>
          <Provider store={store}>
            <QueryClientProvider client={queryClient}>
              <PersistGate loading={<LoadingScreen />} persistor={persistor}>
                <ThemeProvider>
                  <LanguageProvider>
                    <MainApp />
                    <StatusBar style="auto" />
                  </LanguageProvider>
                </ThemeProvider>
              </PersistGate>
            </QueryClientProvider>
          </Provider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </I18nextProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#f8f9fa",
  },
  loadingText: {
    marginTop: 10,
    fontSize: 16,
    color: "#666",
  },
});
