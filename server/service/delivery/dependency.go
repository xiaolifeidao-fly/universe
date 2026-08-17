// 任务依赖：前置关系的归一化、连线锚点，以及拓扑排序的成环校验。

package delivery

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"service/delivery/internal/repository"
)

func normalizeDependencyKeys(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		key := strings.TrimSpace(value)
		if key == "" {
			continue
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, key)
	}
	sort.Strings(result)
	return result
}

func sameStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func dependencyKeysBySuccessor(rows []*repository.DeliveryItemDependency) map[string][]string {
	result := make(map[string][]string)
	for _, row := range rows {
		result[row.SuccessorItemKey] = append(result[row.SuccessorItemKey], row.PredecessorItemKey)
	}
	for itemKey, keys := range result {
		result[itemKey] = normalizeDependencyKeys(keys)
	}
	return result
}

func dependencyTargetSidesBySuccessor(rows []*repository.DeliveryItemDependency) map[string]map[string]string {
	result := make(map[string]map[string]string)
	for _, row := range rows {
		if result[row.SuccessorItemKey] == nil {
			result[row.SuccessorItemKey] = make(map[string]string)
		}
		result[row.SuccessorItemKey][row.PredecessorItemKey] = normalizeDependencyTargetSide(row.TargetSide)
	}
	return result
}

func dependencySourceSidesBySuccessor(rows []*repository.DeliveryItemDependency) map[string]map[string]string {
	result := make(map[string]map[string]string)
	for _, row := range rows {
		if result[row.SuccessorItemKey] == nil {
			result[row.SuccessorItemKey] = make(map[string]string)
		}
		result[row.SuccessorItemKey][row.PredecessorItemKey] = normalizeDependencySide(row.SourceSide)
	}
	return result
}

func normalizeDependencySide(value string) string {
	switch value {
	case "top", "right", "bottom", "left":
		return value
	default:
		return ""
	}
}

func normalizeDependencyTargetSide(value string) string {
	return normalizeDependencySide(value)
}

func normalizeDependencySides(values map[string]string, dependsOnItemKeys []string) map[string]string {
	result := make(map[string]string, len(dependsOnItemKeys))
	for _, itemKey := range dependsOnItemKeys {
		result[itemKey] = normalizeDependencySide(values[itemKey])
	}
	return result
}

func normalizeDependencyTargetSides(values map[string]string, dependsOnItemKeys []string) map[string]string {
	result := make(map[string]string, len(dependsOnItemKeys))
	for _, itemKey := range dependsOnItemKeys {
		result[itemKey] = normalizeDependencyTargetSide(values[itemKey])
	}
	return result
}

func cloneStringMap(values map[string]string) map[string]string {
	result := make(map[string]string, len(values))
	for key, value := range values {
		result[key] = value
	}
	return result
}

func sameStringMap(left, right map[string]string) bool {
	if len(left) != len(right) {
		return false
	}
	for key, value := range left {
		if right[key] != value {
			return false
		}
	}
	return true
}

func containsString(values []string, target string) bool {
	index := sort.SearchStrings(values, target)
	return index < len(values) && values[index] == target
}

// validateDependencyChange 用拓扑排序验证替换后的整张任务图。
func validateDependencyChange(
	items []*repository.DeliveryItem,
	current []*repository.DeliveryItemDependency,
	targetItemKey string,
	predecessorItemKeys []string,
) error {
	known := make(map[string]struct{}, len(items)+1)
	for _, item := range items {
		known[item.ItemKey] = struct{}{}
	}
	// CreateItem 在任务落库前校验，因此目标键需要提前加入图中。
	known[targetItemKey] = struct{}{}
	for _, predecessorItemKey := range predecessorItemKeys {
		if predecessorItemKey == targetItemKey {
			return errors.New("任务不能依赖自己")
		}
		if _, exists := known[predecessorItemKey]; !exists {
			return fmt.Errorf("前置任务 %s 不存在或不属于当前项目", predecessorItemKey)
		}
	}

	indegree := make(map[string]int, len(known))
	adjacency := make(map[string][]string, len(known))
	for itemKey := range known {
		indegree[itemKey] = 0
	}
	addEdge := func(from, to string) {
		if _, ok := known[from]; !ok {
			return
		}
		if _, ok := known[to]; !ok {
			return
		}
		adjacency[from] = append(adjacency[from], to)
		indegree[to]++
	}
	for _, dependency := range current {
		if dependency.SuccessorItemKey == targetItemKey {
			continue
		}
		addEdge(dependency.PredecessorItemKey, dependency.SuccessorItemKey)
	}
	for _, predecessorItemKey := range predecessorItemKeys {
		addEdge(predecessorItemKey, targetItemKey)
	}

	queue := make([]string, 0, len(known))
	for itemKey, degree := range indegree {
		if degree == 0 {
			queue = append(queue, itemKey)
		}
	}
	visited := 0
	for len(queue) > 0 {
		itemKey := queue[0]
		queue = queue[1:]
		visited++
		for _, successor := range adjacency[itemKey] {
			indegree[successor]--
			if indegree[successor] == 0 {
				queue = append(queue, successor)
			}
		}
	}
	if visited != len(known) {
		return errors.New("任务依赖不能形成循环，请调整前置任务")
	}
	return nil
}
