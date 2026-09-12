package repository

import (
	"context"
	"time"

	"gorm.io/gorm/clause"
)

// ai-bridge 安装包的元数据。字节在 OSS，这里只回答「有哪些版本、装哪一个、怎么验」。
//
// 版本高低不在 SQL 里排：语义版本比不出「0.10.0 比 0.9.0 新」这件事（字符串序会反过来），
// 所以这一层只负责取行，排序与「哪个是最新」由 service/galaxy/bridgerelease.go 算。

// SaveBridgeRelease 写一行发布记录。同一个版本 + 平台只有一行：重新上传就是覆盖它
// （service 层只在这一行已经下架时才允许覆盖，见 PublishBridgeRelease）。
func (r *GalaxyRepository) SaveBridgeRelease(ctx context.Context, row *GalaxyBridgeRelease) error {
	return r.Db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "biz_line"}, {Name: "version"}, {Name: "platform"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"release_id", "file_name", "object_key", "size", "sha256", "signature",
			"notes", "status", "published_by", "published_at", "updated_time",
		}),
	}).Create(row).Error
}

func (r *GalaxyRepository) FindBridgeRelease(ctx context.Context, bizLine, releaseID string) (*GalaxyBridgeRelease, error) {
	var row GalaxyBridgeRelease
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("release_id = ?", releaseID).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// FindBridgeReleaseTarget 按「版本 + 平台」取一行。下发升级指令时用它取签名与对象键。
func (r *GalaxyRepository) FindBridgeReleaseTarget(ctx context.Context, bizLine, version, platform string) (*GalaxyBridgeRelease, error) {
	var row GalaxyBridgeRelease
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).
		Where("version = ?", version).Where("platform = ?", platform).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// ListBridgeReleases 全部发布记录。publishedOnly 为真时只要还在架上的那些 ——
// 下载清单与升级目标都只看在架的，运营列表要看全部（含下架的，那是历史）。
func (r *GalaxyRepository) ListBridgeReleases(ctx context.Context, bizLine string, publishedOnly bool) ([]*GalaxyBridgeRelease, error) {
	tx := r.Db.WithContext(ctx).Model(&GalaxyBridgeRelease{}).Where("biz_line = ?", bizLine)
	if publishedOnly {
		tx = tx.Where("status = ?", "published")
	}
	var rows []*GalaxyBridgeRelease
	// 按上传时间兜底排一次，语义版本的序由 service 层重排 —— 但那边拿到的是稳定顺序，
	// 同版本同平台不会因为两次查询的返回顺序不同而跳来跳去。
	err := tx.Order("created_time desc, id desc").Find(&rows).Error
	return rows, err
}

// SetBridgeReleaseStatus 上架 / 下架。返回 false 表示没有这一行。
func (r *GalaxyRepository) SetBridgeReleaseStatus(ctx context.Context, bizLine, releaseID, status string, publishedAt *time.Time) (bool, error) {
	fields := map[string]any{"status": status}
	if publishedAt != nil {
		fields["published_at"] = *publishedAt
	}
	result := r.Db.WithContext(ctx).Model(&GalaxyBridgeRelease{}).
		Where("biz_line = ?", bizLine).Where("release_id = ?", releaseID).
		Updates(fields)
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected > 0, nil
}
