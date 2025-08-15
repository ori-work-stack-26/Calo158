import { useSelector, shallowEqual } from 'react-redux';
import { useMemo } from 'react';
import { RootState } from '@/src/store';

// Memoized selectors to prevent unnecessary re-renders
export const createMemoizedSelector = <T>(
  selector: (state: RootState) => T,
  equalityFn: (left: T, right: T) => boolean = shallowEqual
) => {
  return (state: RootState) => selector(state);
};

// Pre-defined optimized selectors
export const useOptimizedAuthSelector = () => {
  return useSelector(
    useMemo(
      () => (state: RootState) => ({
        isAuthenticated: state.auth.isAuthenticated,
        user: state.auth.user,
        isLoading: state.auth.isLoading,
        error: state.auth.error,
      }),
      []
    ),
    (left, right) => {
      // Custom equality function for better performance
      return (
        left?.isAuthenticated === right?.isAuthenticated &&
        left?.user?.user_id === right?.user?.user_id &&
        left?.user?.email_verified === right?.user?.email_verified &&
        left?.user?.subscription_type === right?.user?.subscription_type &&
        left?.isLoading === right?.isLoading &&
        left?.error === right?.error
      );
    }
  );
};

export const useOptimizedMealSelector = () => {
  return useSelector(
    useMemo(
      () => (state: RootState) => ({
        meals: state.meal.meals,
        isLoading: state.meal.isLoading,
        isAnalyzing: state.meal.isAnalyzing,
        pendingMeal: state.meal.pendingMeal,
        error: state.meal.error,
      }),
      []
    ),
    (left, right) => {
      // Custom equality for meal state
      return (
        left?.meals?.length === right?.meals?.length &&
        left?.isLoading === right?.isLoading &&
        left?.isAnalyzing === right?.isAnalyzing &&
        left?.pendingMeal?.timestamp === right?.pendingMeal?.timestamp &&
        left?.error === right?.error
      );
    }
  );
};

export const useOptimizedCalendarSelector = () => {
  return useSelector(
    useMemo(
      () => (state: RootState) => ({
        calendarData: state.calendar.calendarData,
        statistics: state.calendar.statistics,
        isLoading: state.calendar.isLoading,
        error: state.calendar.error,
      }),
      []
    ),
    shallowEqual
  );
};

export const useOptimizedQuestionnaireSelector = () => {
  return useSelector(
    useMemo(
      () => (state: RootState) => ({
        questionnaire: state.questionnaire.questionnaire,
        isLoading: state.questionnaire.isLoading,
        isSaving: state.questionnaire.isSaving,
        error: state.questionnaire.error,
      }),
      []
    ),
    shallowEqual
  );
};

// User-specific selectors
export const useUserSelector = () => {
  return useSelector(
    useMemo(
      () => (state: RootState) => state.auth.user,
      []
    ),
    (left, right) => {
      if (!left && !right) return true;
      if (!left || !right) return false;
      
      // Compare only essential user fields to prevent unnecessary updates
      return (
        left.user_id === right.user_id &&
        left.email_verified === right.email_verified &&
        left.subscription_type === right.subscription_type &&
        left.is_questionnaire_completed === right.is_questionnaire_completed
      );
    }
  );
};

export const useAuthStatusSelector = () => {
  return useSelector(
    useMemo(
      () => (state: RootState) => state.auth.isAuthenticated,
      []
    )
  );
};

// Meal-specific selectors
export const useRecentMealsSelector = (limit: number = 5) => {
  return useSelector(
    useMemo(
      () => (state: RootState) => {
        const meals = state.meal.meals || [];
        return meals
          .slice()
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
          .slice(0, limit);
      },
      [limit]
    ),
    (left, right) => {
      // Compare only length and first few items for performance
      if (left.length !== right.length) return false;
      if (left.length === 0) return true;
      
      // Compare first 3 items only for performance
      for (let i = 0; i < Math.min(3, left.length); i++) {
        if (left[i]?.meal_id !== right[i]?.meal_id) return false;
      }
      return true;
    }
  );
};

export const useTodayMealsSelector = () => {
  return useSelector(
    useMemo(
      () => (state: RootState) => {
        const meals = state.meal.meals || [];
        const today = new Date().toISOString().split('T')[0];
        return meals.filter(meal => meal.created_at.startsWith(today));
      },
      []
    ),
    shallowEqual
  );
};

export const useMealStatsSelector = () => {
  return useSelector(
    useMemo(
      () => (state: RootState) => {
        const meals = state.meal.meals || [];
        const today = new Date().toISOString().split('T')[0];
        const todayMeals = meals.filter(meal => meal.created_at.startsWith(today));
        
        return todayMeals.reduce(
          (acc, meal) => ({
            calories: acc.calories + (meal.calories || 0),
            protein: acc.protein + (meal.protein || 0),
            carbs: acc.carbs + (meal.carbs || 0),
            fat: acc.fat + (meal.fat || 0),
            mealCount: acc.mealCount + 1,
          }),
          { calories: 0, protein: 0, carbs: 0, fat: 0, mealCount: 0 }
        );
      },
      []
    ),
    shallowEqual
  );
};