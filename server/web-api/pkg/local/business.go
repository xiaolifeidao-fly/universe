// Package local contains in-process adapters used by the aggregate web API.
package local

import (
	"context"

	"contract"
	businessdto "service/business/dto"
	"service/delivery"
)

// BusinessProgramReader adapts delivery's full project service to the small
// project-context port consumed by the business intake domain.
type BusinessProgramReader struct{ Service delivery.Service }

func (reader BusinessProgramReader) ListProgramContexts(ctx context.Context, bizLine contract.BizLine) ([]businessdto.ProgramContext, error) {
	programs, err := reader.Service.ListPrograms(ctx, bizLine)
	if err != nil {
		return nil, err
	}
	contexts := make([]businessdto.ProgramContext, 0, len(programs))
	for _, program := range programs {
		if program.Status != "active" {
			continue
		}
		contexts = append(contexts, businessdto.ProgramContext{
			ProgramID: program.ProgramID, BizLine: program.BizLine.String(), ProgramCode: program.ProgramCode,
			Name: program.Name, Summary: program.Summary,
		})
	}
	return contexts, nil
}

func (reader BusinessProgramReader) ResolveProgramBizLine(ctx context.Context, programID int64) (contract.BizLine, error) {
	return reader.Service.ResolveProgramBizLine(ctx, programID)
}

func (reader BusinessProgramReader) GetProgramContext(ctx context.Context, bizLine contract.BizLine, programID int64) (businessdto.ProgramContext, error) {
	program, err := reader.Service.GetProgram(ctx, bizLine, programID)
	if err != nil {
		return businessdto.ProgramContext{}, err
	}
	return businessdto.ProgramContext{
		ProgramID: program.ProgramID, BizLine: program.BizLine.String(), ProgramCode: program.ProgramCode,
		Name: program.Name, Summary: program.Summary,
	}, nil
}
