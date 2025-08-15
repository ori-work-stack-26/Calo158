import { createSlice, createAsyncThunk, PayloadAction } from "@reduxjs/toolkit";
import {
  Meal,
  MealAnalysisData,
  PendingMeal,
  MealAnalysisSchema,
} from "../types";
import { nutritionAPI, mealAPI } from "../services/api";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import * as FileSystem from "expo-file-system";

interface MealState {
  meals: Meal[];
  pendingMeal: PendingMeal | null;
  isLoading: boolean;
  isAnalyzing: boolean;
  isPosting: boolean;
  isUpdating: boolean;
  isSavingFeedback: boolean;
  isTogglingFavorite: boolean;
  isDuplicating: boolean;
  error: string | null;
}

const initialState: MealState = {
  meals: [],
  pendingMeal: null,
  isLoading: false,
  isAnalyzing: false,
  isPosting: false,
  isUpdating: false,
  isSavingFeedback: false,
  isTogglingFavorite: false,
  isDuplicating: false,
  error: null,
};

const PENDING_MEAL_KEY = "pendingMeal";
const IMAGE_CACHE_SIZE_LIMIT = 1400000; // ~1MB in base64
const IMAGE_COMPRESSION_QUALITY = 0.7;
const MAX_IMAGE_DIMENSION = 800;

// Helper function to compress/resize image if needed
export const processImage = async (imageUri: string): Promise<string> => {
  if (Platform.OS === "web") {
    try {
      console.log("Processing web image:", imageUri);

      let imageData: string;

      if (imageUri.startsWith("data:")) {
        // Extract base64 from data URL
        imageData = imageUri.split(",")[1];
        console.log(
          "Extracted base64 from data URL, length:",
          imageData.length
        );
      } else {
        // Fetch the image with timeout and convert to base64
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        
        const response = await fetch(imageUri, {
          signal: controller.signal,
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          throw new Error(
            `Failed to fetch image: ${response.status} ${response.statusText}`
          );
        }

        const blob = await response.blob();
        console.log("Image blob size:", blob.size, "bytes, type:", blob.type);

        // Convert blob to base64
        const base64Result = await new Promise<string>((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            reject(new Error("FileReader timeout"));
          }, 15000);
          
          const reader = new FileReader();
          reader.onloadend = () => {
            clearTimeout(timeoutId);
            const result = reader.result as string;
            if (!result) {
              reject(new Error("FileReader returned null result"));
              return;
            }

            // Extract base64 part (remove data:image/...;base64, prefix)
            const base64 = result.split(",")[1];
            if (!base64) {
              reject(new Error("Failed to extract base64 from result"));
              return;
            }

            resolve(base64);
          };
          reader.onerror = () => {
            clearTimeout(timeoutId);
            reject(new Error("FileReader failed to read the image"));
          };
          reader.readAsDataURL(blob);
        });

        imageData = base64Result;
      }

      // Compress image if it's too large
      if (imageData.length > IMAGE_CACHE_SIZE_LIMIT) {
        console.log("Image too large, compressing...");

        // Create an image element to resize
        const img = new Image();
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");

        const compressedBase64 = await new Promise<string>(
          (resolve, reject) => {
            const timeoutId = setTimeout(() => {
              reject(new Error("Image compression timeout"));
            }, 10000);
            
            img.onload = () => {
              clearTimeout(timeoutId);
              // Calculate new dimensions (max 800px on longest side)
              const maxDimension = MAX_IMAGE_DIMENSION;
              let { width, height } = img;

              if (width > height && width > maxDimension) {
                height = (height * maxDimension) / width;
                width = maxDimension;
              } else if (height > maxDimension) {
                width = (width * maxDimension) / height;
                height = maxDimension;
              }

              canvas.width = width;
              canvas.height = height;

              if (!ctx) {
                reject(new Error("Failed to get canvas context"));
                return;
              }

              ctx.drawImage(img, 0, 0, width, height);

              // Convert to base64 with quality compression
              const compressedDataUrl = canvas.toDataURL("image/jpeg", IMAGE_COMPRESSION_QUALITY);
              const compressedBase64 = compressedDataUrl.split(",")[1];

              console.log(
                "Compressed image from",
                imageData.length,
                "to",
                compressedBase64.length
              );
              resolve(compressedBase64);
            };

            img.onerror = () => {
              clearTimeout(timeoutId);
              reject(new Error("Failed to load image for compression"));
            };
            img.src = `data:image/jpeg;base64,${imageData}`;
          }
        );

        return compressedBase64;
      }

      console.log("Web image processed, base64 length:", imageData.length);
      return imageData;
    } catch (error) {
      console.error("Error processing web image:", error);
      throw new Error(
        "Failed to process image: " +
          (error instanceof Error ? error.message : "Unknown error")
      );
    }
  } else {
    // Native processing (React Native)
    try {
      console.log("Processing native image:", imageUri);

      // For native, use FileSystem to read the image
      const imageInfo = await FileSystem.getInfoAsync(imageUri);
      if (!imageInfo.exists) {
        throw new Error("Image file does not exist");
      }

      console.log("Image file size:", imageInfo.size);

      // Read as base64 directly
      const base64 = await FileSystem.readAsStringAsync(imageUri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      console.log("Native image processed, base64 length:", base64.length);
      return base64;
    } catch (error) {
      console.error("Error processing native image:", error);
      throw new Error(
        "Failed to process image: " +
          (error instanceof Error ? error.message : "Unknown error")
      );
    }
  }
};

export const analyzeMeal = createAsyncThunk(
  "meal/analyzeMeal",
  async (
    params: {
      imageBase64: string;
      updateText?: string;
      language?: string;
      editedIngredients?: any[];
    },
    { rejectWithValue, signal }
  ) => {
    try {
      console.log("Starting meal analysis with base64 data...");

      // Validate input
      if (!params.imageBase64 || params.imageBase64.trim() === "") {
        throw new Error("Image data is empty or invalid");
      }

      // Clean base64 string - handle both raw base64 and data URLs
      let cleanBase64 = params.imageBase64;
      if (params.imageBase64.startsWith("data:")) {
        cleanBase64 = params.imageBase64.split(",")[1];
      }

      console.log("Base64 data length:", cleanBase64.length);

      // Make the API call with proper error handling
      const response = await Promise.race([
        nutritionAPI.analyzeMeal(
          cleanBase64,
          params.updateText,
          params.editedIngredients || [],
          params.language || "en",
          { signal }
        ),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Analysis timeout")), 45000)
        ),
      ]);
      
      console.log("API response received:", response);

      if (response && response.success && response.data) {
        // Validate API response data
        try {
          const validatedData = MealAnalysisSchema.parse(response.data);
          console.log("Data validation successful");
        } catch (validationError) {
          console.warn("API response validation failed:", validationError);
          // Continue anyway, but log the issue
        }

        // Ensure ingredients array is properly formatted
        if (
          response.data.ingredients &&
          Array.isArray(response.data.ingredients)
        ) {
          response.data.ingredients = response.data.ingredients.map(
            (ingredient: any) => ({
              name: ingredient.name || "Unknown ingredient",
              calories: Number(ingredient.calories) || 0,
              protein: Number(ingredient.protein || ingredient.protein_g) || 0,
              carbs: Number(ingredient.carbs || ingredient.carbs_g) || 0,
              fat: Number(ingredient.fat || ingredient.fats_g) || 0,
              fiber: Number(ingredient.fiber || ingredient.fiber_g) || 0,
              sugar: Number(ingredient.sugar || ingredient.sugar_g) || 0,
              sodium_mg: Number(ingredient.sodium_mg || ingredient.sodium) || 0,
            })
          );
        }

        const pendingMeal: PendingMeal = {
          image_base_64: cleanBase64, // Store clean base64 without data URL prefix
          analysis: response.data,
          timestamp: Date.now(),
        };
        console.log("Pending meal created:", pendingMeal);

        // Save to storage with error handling
        try {
          const serializedMeal = JSON.stringify(pendingMeal);
          await AsyncStorage.setItem(PENDING_MEAL_KEY, serializedMeal);
          console.log("Pending meal saved to storage successfully");
        } catch (storageError) {
          console.warn("Failed to save pending meal to storage:", storageError);
          // Don't fail the analysis if storage fails
        }

        console.log("Analysis completed successfully");
        return pendingMeal;
      } else {
        const errorMessage =
          response?.error || "Analysis failed - no data returned from server";
        console.error("Analysis failed:", errorMessage);
        return rejectWithValue(errorMessage);
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log('Analysis request aborted');
        return rejectWithValue('Analysis was cancelled');
      }
      console.error("Analysis error details:", error);

      let errorMessage = "Analysis failed";
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === "string") {
        errorMessage = error;
      }

      // Enhanced error handling with specific AI service messages
      if (
        errorMessage.includes("Network Error") ||
        errorMessage.includes("ERR_NETWORK")
      ) {
        errorMessage = "Network error - please check your connection";
      } else if (
        errorMessage.includes("quota") ||
        errorMessage.includes("billing")
      ) {
        errorMessage =
          "AI analysis temporarily unavailable - please try again later";
      } else if (errorMessage.includes("Invalid image data")) {
        errorMessage = "Invalid image - please try a different photo";
      } else if (errorMessage.includes("OpenAI API key not configured")) {
        errorMessage = "AI service not available - please contact support";
      } else if (errorMessage.includes("400")) {
        errorMessage = "Invalid image data - please try a different image";
      } else if (errorMessage.includes("401") || errorMessage.includes("403")) {
        errorMessage = "Authentication error - please log in again";
      } else if (errorMessage.includes("500")) {
        errorMessage = "Server error - please try again later";
      } else if (errorMessage.includes("timeout")) {
        errorMessage = "Analysis is taking too long - please try again";
      }

      return rejectWithValue(errorMessage);
    }
  }
);

export const validateAndFixBase64Image = (
  base64String: string
): string | null => {
  try {
    // Check if it's already a complete data URL
    if (base64String.startsWith("data:image/")) {
      return base64String;
    }

    // If it's just the base64 part, add the data URL prefix
    if (base64String.match(/^[A-Za-z0-9+/]*={0,2}$/)) {
      return `data:image/jpeg;base64,${base64String}`;
    }

    return null;
  } catch (error) {
    console.error("Base64 validation error:", error);
    return null;
  }
};

export const updateMeal = createAsyncThunk(
  "meal/updateMeal",
  async (
    { meal_id, updateText }: { meal_id: string; updateText: string },
    { rejectWithValue }
  ) => {
    try {
      console.log("Starting meal update...");

      const response = await nutritionAPI.updateMeal(meal_id, updateText);
      console.log("Update response received:", response);

      if (response && response.success && response.data) {
        console.log("Meal updated successfully");
        return response.data;
      } else {
        const errorMessage =
          response?.error || "Update failed - no data returned";
        console.error("Update failed:", errorMessage);
        return rejectWithValue(errorMessage);
      }
    } catch (error) {
      console.error("Update error details:", error);

      let errorMessage = "Update failed";
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === "string") {
        errorMessage = error;
      }

      return rejectWithValue(errorMessage);
    }
  }
);

export const postMeal = createAsyncThunk(
  "meal/postMeal",
  async (_, { getState, rejectWithValue }) => {
    try {
      const state = getState() as { meal: MealState };
      const { pendingMeal } = state.meal;

      if (!pendingMeal) {
        return rejectWithValue("No pending meal to post");
      }

      if (!pendingMeal.analysis) {
        return rejectWithValue("No meal analysis data to post");
      }

      console.log("Posting meal with analysis:", pendingMeal.analysis);
      const response = await nutritionAPI.saveMeal(
        pendingMeal.analysis,
        pendingMeal.image_base_64
      );

      if (response) {
        // Clean up storage
        try {
          await AsyncStorage.removeItem(PENDING_MEAL_KEY);
          console.log("Pending meal removed from storage");
        } catch (storageError) {
          console.warn(
            "Failed to remove pending meal from storage:",
            storageError
          );
        }

        console.log("Meal posted successfully");
        return response;
      }

      return rejectWithValue("Failed to post meal - no response from server");
    } catch (error) {
      console.error("Post meal error:", error);

      let errorMessage = "Failed to post meal";
      if (error instanceof Error) {
        errorMessage = error.message;
      }

      return rejectWithValue(errorMessage);
    }
  }
);

export const fetchMeals = createAsyncThunk(
  "meal/fetchMeals",
  async (_, { rejectWithValue }) => {
    try {
      console.log("Fetching meals from API...");
      const meals = await nutritionAPI.getMeals();
      console.log("Meals fetched successfully, count:", meals?.length || 0);
      return meals || [];
    } catch (error) {
      console.error("Fetch meals error:", error);

      let errorMessage = "Failed to fetch meals";
      if (error instanceof Error) {
        errorMessage = error.message;
      }

      return rejectWithValue(errorMessage);
    }
  }
);

// NEW THUNKS FOR HISTORY FEATURES

export const saveMealFeedback = createAsyncThunk(
  "meal/saveMealFeedback",
  async (
    {
      mealId,
      feedback,
    }: {
      mealId: string;
      feedback: {
        tasteRating?: number;
        satietyRating?: number;
        energyRating?: number;
        heavinessRating?: number;
      };
    },
    { rejectWithValue }
  ) => {
    try {
      console.log("💬 Saving meal feedback...");
      const response = await nutritionAPI.saveMealFeedback(mealId, feedback);
      console.log("✅ Feedback saved successfully");
      return { mealId, feedback };
    } catch (error) {
      console.error("💥 Save feedback error:", error);
      return rejectWithValue("Failed to save feedback");
    }
  }
);

export const toggleMealFavorite = createAsyncThunk(
  "meal/toggleMealFavorite",
  async (mealId: string, { rejectWithValue }) => {
    try {
      console.log("❤️ Toggling meal favorite...");
      const response = await nutritionAPI.toggleMealFavorite(mealId);
      console.log("✅ Favorite toggled successfully");
      return { mealId, isFavorite: response.data.isFavorite };
    } catch (error) {
      console.error("💥 Toggle favorite error:", error);
      return rejectWithValue("Failed to toggle favorite");
    }
  }
);

export const duplicateMeal = createAsyncThunk(
  "meal/duplicateMeal",
  async (
    { mealId, newDate }: { mealId: string; newDate: string },
    { rejectWithValue }
  ) => {
    try {
      const response = await nutritionAPI.duplicateMeal(mealId, newDate);
      console.log("✅ Meal duplicated successfully");

      if (response.success && response.data) {
        return response.data;
      } else {
        return rejectWithValue(response.error || "Failed to duplicate meal");
      }
    } catch (error) {
      console.error("💥 Duplicate meal error:", error);
      return rejectWithValue("Failed to duplicate meal");
    }
  }
);

export const removeMeal = createAsyncThunk(
  "meal/removeMeal",
  async (mealId: string, { rejectWithValue }) => {
    try {
      await nutritionAPI.removeMeal(mealId);
      return mealId;
    } catch (error: any) {
      console.error("Remove meal error:", error);
      return rejectWithValue(error.message || "Failed to remove meal");
    }
  }
);

export const loadPendingMeal = createAsyncThunk(
  "meal/loadPendingMeal",
  async (_, { rejectWithValue }) => {
    try {
      console.log("Loading pending meal from storage...");
      const stored = await AsyncStorage.getItem(PENDING_MEAL_KEY);

      if (stored && stored.trim() !== "") {
        try {
          const pendingMeal = JSON.parse(stored);
          console.log("Pending meal loaded from storage:", pendingMeal);

          // Validate the loaded data structure
          if (
            pendingMeal &&
            typeof pendingMeal === "object" &&
            pendingMeal.timestamp
          ) {
            return pendingMeal;
          } else {
            console.warn("Invalid pending meal structure, clearing storage");
            await AsyncStorage.removeItem(PENDING_MEAL_KEY);
            return null;
          }
        } catch (parseError) {
          console.error(
            "Failed to parse pending meal from storage:",
            parseError
          );
          // Clear corrupted data
          await AsyncStorage.removeItem(PENDING_MEAL_KEY);
          return null;
        }
      } else {
        console.log("No pending meal found in storage");
        return null;
      }
    } catch (error) {
      console.error("Load pending meal error:", error);
      // Don't reject, just return null for storage errors
      return null;
    }
  }
);

const mealSlice = createSlice({
  name: "meal",
  initialState,
  reducers: {
    clearError: (state) => {
      state.error = null;
    },
    clearPendingMeal: (state) => {
      state.pendingMeal = null;
      // Clear from storage asynchronously
      AsyncStorage.removeItem(PENDING_MEAL_KEY).catch((error) => {
        console.warn("Failed to remove pending meal from storage:", error);
      });
    },
    setPendingMeal: (state, action: PayloadAction<PendingMeal>) => {
      state.pendingMeal = action.payload;
    },
    setPendingMealForUpdate: (
      state,
      action: PayloadAction<{ meal_id: string; imageBase64: string }>
    ) => {
      state.pendingMeal = {
        image_base_64: action.payload.imageBase64,
        analysis: null,
        timestamp: Date.now(),
        meal_id: action.payload.meal_id,
      };
    },
    updateMealLocally: (state, action) => {
      state.meals = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      // Analyze meal cases
      .addCase(analyzeMeal.pending, (state) => {
        state.isAnalyzing = true;
        state.error = null;
        console.log("Analysis started...");
      })
      .addCase(analyzeMeal.fulfilled, (state, action) => {
        state.isAnalyzing = false;
        state.pendingMeal = action.payload;
        state.error = null;
        console.log("Analysis completed successfully");
      })
      .addCase(analyzeMeal.rejected, (state, action) => {
        state.isAnalyzing = false;
        state.error = action.payload as string;
        console.log("Analysis failed:", action.payload);
      })

      // Update meal cases
      .addCase(updateMeal.pending, (state) => {
        state.isUpdating = true;
        state.error = null;
        console.log("Update started...");
      })
      .addCase(updateMeal.fulfilled, (state, action) => {
        state.isUpdating = false;
        state.error = null;
        // Update the meal in the meals array
        const updatedMeal = action.payload;
        const index = state.meals.findIndex(
          (meal) => meal.id === updatedMeal.id
        );
        if (index !== -1) {
          state.meals[index] = updatedMeal;
        }
        // Clear pending meal after successful update
        state.pendingMeal = null;
        console.log("Update completed successfully");
      })
      .addCase(updateMeal.rejected, (state, action) => {
        state.isUpdating = false;
        state.error = action.payload as string;
        console.log("Update failed:", action.payload);
      })

      // Post meal cases
      .addCase(postMeal.pending, (state) => {
        state.isPosting = true;
        state.error = null;
        console.log("Posting meal...");
      })
      .addCase(postMeal.fulfilled, (state, action) => {
        state.isPosting = false;
        state.pendingMeal = null;
        state.error = null;
        // Add the new meal to the beginning of the list
        if (action.payload) {
          state.meals.unshift(action.payload);
        }
        console.log("Meal posted successfully");
      })
      .addCase(postMeal.rejected, (state, action) => {
        state.isPosting = false;
        state.error = action.payload as string;
        console.log("Meal posting failed:", action.payload);
      })

      // Fetch meals cases
      .addCase(fetchMeals.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(fetchMeals.fulfilled, (state, action) => {
        state.isLoading = false;
        state.meals = action.payload;
        state.error = null;
      })
      .addCase(fetchMeals.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload as string;
      })
      .addCase(removeMeal.pending, (state) => {
        state.isLoading = true;
      })
      .addCase(removeMeal.fulfilled, (state, action) => {
        state.isLoading = false;
        state.meals = state.meals.filter((meal) => meal.id !== action.payload);
      })
      .addCase(removeMeal.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload as string;
      })

      // Save meal feedback cases
      .addCase(saveMealFeedback.pending, (state) => {
        state.isSavingFeedback = true;
        state.error = null;
      })
      .addCase(saveMealFeedback.fulfilled, (state, action) => {
        state.isSavingFeedback = false;
        // Update meal with feedback in the state
        const { mealId, feedback } = action.payload;
        const mealIndex = state.meals.findIndex((meal) => meal.id === mealId);
        if (mealIndex !== -1) {
          const meal = state.meals[mealIndex] as any;
          meal.tasteRating = feedback.tasteRating || meal.tasteRating;
          meal.satietyRating = feedback.satietyRating || meal.satietyRating;
          meal.energyRating = feedback.energyRating || meal.energyRating;
          meal.heavinessRating =
            feedback.heavinessRating || meal.heavinessRating;
        }
        console.log("Feedback saved successfully");
      })
      .addCase(saveMealFeedback.rejected, (state, action) => {
        state.isSavingFeedback = false;
        state.error = action.payload as string;
      })

      // Toggle meal favorite cases
      .addCase(toggleMealFavorite.pending, (state) => {
        state.isTogglingFavorite = true;
        state.error = null;
      })
      .addCase(toggleMealFavorite.fulfilled, (state, action) => {
        state.isTogglingFavorite = false;
        // Update meal favorite status in the state
        const { mealId, isFavorite } = action.payload;
        const mealIndex = state.meals.findIndex((meal) => meal.id === mealId);
        if (mealIndex !== -1) {
          (state.meals[mealIndex] as any).isFavorite = isFavorite;
        }
        console.log("Favorite toggled successfully");
      })
      .addCase(toggleMealFavorite.rejected, (state, action) => {
        state.isTogglingFavorite = false;
        state.error = action.payload as string;
      })

      // Duplicate meal cases
      .addCase(duplicateMeal.pending, (state) => {
        state.isDuplicating = true;
        state.error = null;
      })
      .addCase(duplicateMeal.fulfilled, (state, action) => {
        state.isDuplicating = false;
        // Add duplicated meal to the beginning of the list
        if (action.payload) {
          state.meals.unshift(action.payload);
        }
        console.log("Meal duplicated successfully");
      })
      .addCase(duplicateMeal.rejected, (state, action) => {
        state.isDuplicating = false;
        state.error = action.payload as string;
      })

      // Load pending meal cases
      .addCase(loadPendingMeal.pending, (state) => {
        // Don't show loading for this background operation
      })
      .addCase(loadPendingMeal.fulfilled, (state, action) => {
        if (action.payload) {
          state.pendingMeal = action.payload;
          console.log("Pending meal restored from storage");
        }
      })
      .addCase(loadPendingMeal.rejected, (state, action) => {
        // Don't set error for storage loading failures
        console.warn("Failed to load pending meal:", action.payload);
      });
  },
});

// Add meal deletion thunk
export const deleteMeal = createAsyncThunk(
  "meals/delete",
  async (mealId: string, { rejectWithValue, dispatch }) => {
    try {
      await mealAPI.deleteMeal(mealId);

      // Refresh all meal-related data after deletion
      dispatch(fetchMeals());

      return mealId;
    } catch (error: any) {
      return rejectWithValue(
        error.response?.data?.error || error.message || "Failed to delete meal"
      );
    }
  }
);

export const {
  clearError,
  clearPendingMeal,
  setPendingMeal,
  setPendingMealForUpdate,
  updateMealLocally,
} = mealSlice.actions;
export default mealSlice.reducer;
