package db

import (
	"fmt"
	"sync"

	"gorm.io/gorm"
)

// Entity is the common persistence contract implemented by every domain model.
type Entity interface {
	TableName() string
	Init()
}

type Repository[T Entity] struct {
	Db *gorm.DB
}

func (r *Repository[T]) SetDb(database *gorm.DB) { r.Db = database }

var (
	database     *gorm.DB
	repositories = make(map[string]any)
	mu           sync.Mutex
)

func SetDatabase(value *gorm.DB) {
	mu.Lock()
	defer mu.Unlock()
	database = value
	repositories = make(map[string]any)
}

func Database() *gorm.DB {
	mu.Lock()
	defer mu.Unlock()
	return database
}

func GetRepository[R any]() *R {
	key := fmt.Sprintf("%T", new(R))
	mu.Lock()
	defer mu.Unlock()
	if value, ok := repositories[key]; ok {
		return value.(*R)
	}

	repository := new(R)
	if setter, ok := any(repository).(interface{ SetDb(*gorm.DB) }); ok {
		setter.SetDb(database)
	}
	repositories[key] = repository
	return repository
}
