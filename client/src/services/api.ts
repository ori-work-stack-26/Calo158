import axios, { AxiosInstance, AxiosRequestConfig } from "axios";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

// Enhanced API configuration with better timeout and retry logic
const API_CONFIG = {
  timeout: 30000, // 30 seconds default timeout
  retryAttempts: 3,
  retryDelay: 1000, // 1 second base delay
  maxRetryDelay: 5000, // 5 seconds max delay
};

// Get the correct API URL based on platform
const getApiBaseUrl = () => {
  if (Platform.OS === "web") {
    return process.env.EXPO_PUBLIC_API_URL || "http://localhost:5000/api";
  } else {
    return process.env.EXPO_PUBLIC_API_URL || "http://192.168.1.100:5000/api";
  }
};

// Create axios instance with optimized configuration
export const api: AxiosInstance = axios.create({
  baseURL: getApiBaseUrl(),
  timeout: API_CONFIG.timeout,
  withCredentials: Platform.OS === "web",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
  },
});

// Enhanced retry logic with exponential backoff
const retryRequest = async (
  requestFn: () => Promise<any>,
  attempt: number = 1
): Promise<any> => {
  try {
    return await requestFn();
  } catch (error: any) {
    if (attempt >= API_CONFIG.retryAttempts) {
      throw error;
    }

    // Don't retry on certain error types
    if (
      error.response?.status === 401 ||
      error.response?.status === 403 ||
      error.response?.status === 422 ||
      error.name === "AbortError"
    ) {
      throw error;
    }

    // Calculate delay with exponential backoff
    const delay = Math.min(
      API_CONFIG.retryDelay * Math.pow(2, attempt - 1),
      API_CONFIG.maxRetryDelay
    );

    console.log(`🔄 Retrying request (attempt ${attempt + 1}) in ${delay}ms`);
    
    await new Promise((resolve) => setTimeout(resolve, delay));
    return retryRequest(requestFn, attempt + 1);
  }
};

// Enhanced request interceptor with better token handling
api.interceptors.request.use(
  async (config) => {
    try {
      let token: string | null = null;

      // Get token based on platform
      if (Platform.OS === "web") {
        token = localStorage.getItem("auth_token");
      } else {
        try {
          token = await SecureStore.getItemAsync("auth_token_secure");
        } catch (error) {
          console.warn("Failed to get token from SecureStore:", error);
          // Fallback to AsyncStorage
          token = await AsyncStorage.getItem("auth_token");
        }
      }

      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }

      // Add request timestamp for debugging
      config.metadata = { startTime: Date.now() };
      
      console.log(`🚀 API Request: ${config.method?.toUpperCase()} ${config.url}`);
      return config;
    } catch (error) {
      console.error("Request interceptor error:", error);
      return config;
    }
  },
  (error) => {
    console.error("Request interceptor error:", error);
    return Promise.reject(error);
  }
);

// Enhanced response interceptor with better error handling
api.interceptors.response.use(
  (response) => {
    const duration = Date.now() - (response.config.metadata?.startTime || 0);
    console.log(`✅ API Response: ${response.config.url} (${duration}ms)`);
    return response;
  },
  async (error) => {
    const duration = Date.now() - (error.config?.metadata?.startTime || 0);
    console.error(`❌ API Error: ${error.config?.url} (${duration}ms)`, error.response?.status);

    // Handle token expiration
    if (error.response?.status === 401) {
      console.log("🔒 Token expired, clearing auth data");
      
      try {
        if (Platform.OS === "web") {
          localStorage.removeItem("auth_token");
        } else {
          await SecureStore.deleteItemAsync("auth_token_secure");
          await AsyncStorage.removeItem("auth_token");
        }
      } catch (clearError) {
        console.warn("Failed to clear auth tokens:", clearError);
      }

      // Redirect to login if we have access to router
      if (typeof window !== "undefined" && window.location) {
        window.location.href = "/signin";
      }
    }

    return Promise.reject(error);
  }
);

// Enhanced API service classes with better error handling and caching
export class AuthAPI {
  private static tokenCache: string | null = null;
  private static tokenCacheTime: number = 0;
  private static readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

  static async signUp(data: any) {
    return retryRequest(() => api.post("/auth/signup", data));
  }

  static async signIn(data: any) {
    const response = await retryRequest(() => api.post("/auth/signin", data));
    
    // Cache token for faster subsequent requests
    if (response.data.token) {
      this.tokenCache = response.data.token;
      this.tokenCacheTime = Date.now();
    }
    
    return response;
  }

  static async verifyEmail(email: string, code: string) {
    return retryRequest(() => api.post("/auth/verify-email", { email, code }));
  }

  static async signOut() {
    try {
      await api.post("/auth/signout");
    } catch (error) {
      console.warn("Signout request failed:", error);
    } finally {
      // Clear cache regardless of API response
      this.tokenCache = null;
      this.tokenCacheTime = 0;
      
      if (Platform.OS === "web") {
        localStorage.removeItem("auth_token");
      } else {
        try {
          await SecureStore.deleteItemAsync("auth_token_secure");
        } catch (error) {
          console.warn("Failed to clear SecureStore:", error);
        }
        await AsyncStorage.removeItem("auth_token");
      }
    }
  }

  static async getStoredToken(): Promise<string | null> {
    // Use cache if available and fresh
    if (
      this.tokenCache &&
      Date.now() - this.tokenCacheTime < this.CACHE_DURATION
    ) {
      return this.tokenCache;
    }

    try {
      let token: string | null = null;

      if (Platform.OS === "web") {
        token = localStorage.getItem("auth_token");
      } else {
        try {
          token = await SecureStore.getItemAsync("auth_token_secure");
        } catch (error) {
          console.warn("SecureStore access failed, trying AsyncStorage:", error);
          token = await AsyncStorage.getItem("auth_token");
        }
      }

      // Update cache
      if (token) {
        this.tokenCache = token;
        this.tokenCacheTime = Date.now();
      }

      return token;
    } catch (error) {
      console.error("Error getting stored token:", error);
      return null;
    }
  }
}

export class NutritionAPI {
  private static requestQueue: Map<string, Promise<any>> = new Map();

  static async analyzeMeal(
    imageBase64: string,
    updateText?: string,
    editedIngredients: any[] = [],
    language: string = "en",
    options: AxiosRequestConfig = {}
  ) {
    // Create request key for deduplication
    const requestKey = `analyze_${imageBase64.substring(0, 50)}_${updateText || ''}`;
    
    // Check if same request is already in progress
    if (this.requestQueue.has(requestKey)) {
      console.log("🔄 Reusing existing analysis request");
      return this.requestQueue.get(requestKey);
    }

    const requestPromise = retryRequest(() =>
      api.post(
        "/nutrition/analyze",
        {
          imageBase64,
          updateText,
          editedIngredients,
          language,
        },
        {
          timeout: 45000, // 45 seconds for analysis
          ...options,
        }
      )
    );

    // Cache the request
    this.requestQueue.set(requestKey, requestPromise);

    try {
      const response = await requestPromise;
      return response.data;
    } finally {
      // Remove from queue after completion
      setTimeout(() => {
        this.requestQueue.delete(requestKey);
      }, 1000);
    }
  }

  static async saveMeal(mealData: any, imageBase64?: string) {
    return retryRequest(() =>
      api.post("/nutrition/save", { mealData, imageBase64 }, {
        timeout: 20000, // 20 seconds for save
      })
    );
  }

  static async getMeals(offset = 0, limit = 100) {
    const response = await retryRequest(() =>
      api.get(`/nutrition/meals?offset=${offset}&limit=${limit}`, {
        timeout: 15000, // 15 seconds for meals
      })
    );
    return response.data.data || [];
  }

  static async updateMeal(mealId: string, updateText: string) {
    return retryRequest(() =>
      api.put("/nutrition/update", { meal_id: mealId, updateText }, {
        timeout: 30000, // 30 seconds for update
      })
    );
  }

  static async getDailyStats(date: string) {
    const response = await retryRequest(() =>
      api.get(`/nutrition/stats/daily?date=${date}`, {
        timeout: 10000, // 10 seconds for stats
      })
    );
    return response.data.data || {};
  }

  static async getRangeStatistics(startDate: string, endDate: string) {
    const response = await retryRequest(() =>
      api.get(`/nutrition/stats/range?startDate=${startDate}&endDate=${endDate}`, {
        timeout: 20000, // 20 seconds for range stats
      })
    );
    return response.data;
  }

  static async saveMealFeedback(mealId: string, feedback: any) {
    return retryRequest(() =>
      api.post(`/nutrition/meals/${mealId}/feedback`, feedback, {
        timeout: 10000,
      })
    );
  }

  static async toggleMealFavorite(mealId: string) {
    return retryRequest(() =>
      api.post(`/nutrition/meals/${mealId}/favorite`, {}, {
        timeout: 10000,
      })
    );
  }

  static async duplicateMeal(mealId: string, newDate?: string) {
    return retryRequest(() =>
      api.post(`/nutrition/meals/${mealId}/duplicate`, { newDate }, {
        timeout: 15000,
      })
    );
  }

  static async removeMeal(mealId: string) {
    return retryRequest(() =>
      api.delete(`/nutrition/meals/${mealId}`, {
        timeout: 10000,
      })
    );
  }
}

export class ChatAPI {
  private static messageCache: Map<string, any> = new Map();
  private static readonly CACHE_DURATION = 2 * 60 * 1000; // 2 minutes

  static async sendMessage(
    message: string,
    language: string = "english",
    options: AxiosRequestConfig = {}
  ) {
    // Create cache key
    const cacheKey = `${message}_${language}`;
    const cached = this.messageCache.get(cacheKey);
    
    // Return cached response if available and fresh
    if (cached && Date.now() - cached.timestamp < this.CACHE_DURATION) {
      console.log("🔄 Using cached chat response");
      return cached.response;
    }

    const response = await retryRequest(() =>
      api.post(
        "/chat/message",
        { message, language },
        {
          timeout: 35000, // 35 seconds for chat
          ...options,
        }
      )
    );

    // Cache successful responses
    if (response.data.success) {
      this.messageCache.set(cacheKey, {
        response: response.data,
        timestamp: Date.now(),
      });

      // Clean old cache entries
      if (this.messageCache.size > 50) {
        const oldestKey = this.messageCache.keys().next().value;
        this.messageCache.delete(oldestKey);
      }
    }

    return response.data;
  }

  static async getChatHistory(limit: number = 20, options: AxiosRequestConfig = {}) {
    return retryRequest(() =>
      api.get(`/chat/history?limit=${limit}`, {
        timeout: 10000,
        ...options,
      })
    );
  }

  static async clearHistory(options: AxiosRequestConfig = {}) {
    const response = await retryRequest(() =>
      api.delete("/chat/history", {
        timeout: 10000,
        ...options,
      })
    );
    
    // Clear message cache when history is cleared
    this.messageCache.clear();
    
    return response;
  }
}

export class QuestionnaireAPI {
  static async getQuestionnaire(options: AxiosRequestConfig = {}) {
    return retryRequest(() =>
      api.get("/questionnaire", {
        timeout: 15000,
        ...options,
      })
    );
  }

  static async saveQuestionnaire(data: any) {
    return retryRequest(() =>
      api.post("/questionnaire", data, {
        timeout: 25000, // 25 seconds for questionnaire save
      })
    );
  }
}

export class UserAPI {
  static async updateProfile(data: any) {
    return retryRequest(() =>
      api.put("/user/profile", data, {
        timeout: 15000,
      })
    );
  }

  static async updateSubscription(subscriptionType: string) {
    return retryRequest(() =>
      api.put("/user/subscription", { subscription_type: subscriptionType }, {
        timeout: 15000,
      })
    );
  }

  static async getUserProfile() {
    return retryRequest(() =>
      api.get("/user/profile", {
        timeout: 10000,
      })
    );
  }

  static async getGlobalStatistics() {
    return retryRequest(() =>
      api.get("/user/global-statistics", {
        timeout: 20000,
      })
    );
  }

  static async forgotPassword(email: string) {
    return retryRequest(() =>
      api.post("/auth/forgot-password", { email }, {
        timeout: 15000,
      })
    );
  }

  static async verifyResetCode(email: string, code: string) {
    return retryRequest(() =>
      api.post("/auth/verify-reset-code", { email, code }, {
        timeout: 10000,
      })
    );
  }

  static async resetPassword(token: string, newPassword: string) {
    return retryRequest(() =>
      api.post("/auth/reset-password", { token, newPassword }, {
        timeout: 15000,
      })
    );
  }
}

export class CalendarAPI {
  static async getCalendarData(year: number, month: number) {
    return retryRequest(() =>
      api.get(`/calendar/data/${year}/${month}`, {
        timeout: 15000,
      })
    );
  }

  static async getStatistics(year: number, month: number) {
    return retryRequest(() =>
      api.get(`/calendar/statistics/${year}/${month}`, {
        timeout: 15000,
      })
    );
  }

  static async addEvent(
    date: string,
    title: string,
    type: string,
    description?: string
  ) {
    return retryRequest(() =>
      api.post("/calendar/events", { date, title, type, description }, {
        timeout: 10000,
      })
    );
  }

  static async deleteEvent(eventId: string) {
    return retryRequest(() =>
      api.delete(`/calendar/events/${eventId}`, {
        timeout: 10000,
      })
    );
  }

  static async getEventsForDate(date: string) {
    return retryRequest(() =>
      api.get(`/calendar/events/${date}`, {
        timeout: 10000,
      })
    );
  }
}

// Export individual APIs
export const authAPI = AuthAPI;
export const nutritionAPI = NutritionAPI;
export const chatAPI = ChatAPI;
export const questionnaireAPI = QuestionnaireAPI;
export const userAPI = UserAPI;
export const calendarAPI = CalendarAPI;

// Export default api instance
export default api;